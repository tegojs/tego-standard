import { ACL, Transaction, type Collection, type Database, type Model } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import {
  AccessCreationService,
  type AccessCreationPlan,
  type AccessCreationRequest,
} from '../../access-control/creation';
import type { AccessCreationLink } from '../../access-control/creation-links';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

/** Explicit service inputs are already operation/field-authorized; no action permission is inferred here. */
describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('creation with per-row links (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let projects: Collection;
  let through: Collection;
  let store: AccessConfigStore;
  let adapter: AccessAclScopeAdapter;
  let service: AccessCreationService;
  let ctx: object;
  const actor = { tenantId: 'B', userId: 28, roleName: 'importer' };
  const identity = (collection: Collection) =>
    collection === docs
      ? mainIdentity
      : {
          ...mainIdentity,
          collectionName: collection.name,
          collectionKey: `${collection.name}-key`,
        };
  const pg = (name: string, run: () => Promise<void>) => it.runIf(dialect === 'postgres')(name, run);
  const link = (keys: number[], where?: object): AccessCreationLink => ({
    association: 'projects',
    target: identity(projects),
    through: identity(through),
    keys,
    ...(where ? { where } : {}),
  });
  const input = () => ({
    values: [{ name: 'First' }, { name: 'Second' }],
    rowLinks: [[link([101, 104])], [link([103])]],
  });
  const rows = async () => (await docs.model.findAll({ order: [['id', 'ASC']] })).map((record) => record.get());
  const connections = async () => {
    const sources = await rows();
    const stored = await through.model.findAll({ order: [['targetId', 'ASC']] });
    return sources.map((source) => ({
      name: source.name,
      keys: stored
        .filter((row) => Number(row.get('documentId')) === Number(source.id))
        .map((row) => Number(row.get('targetId'))),
    }));
  };
  const write = async (plan: AccessCreationPlan): Promise<Model[]> => {
    const result: Model[] = [];
    for (const values of plan.values)
      result.push(await docs.repository.create({ values, transaction: plan.transaction }));
    return result;
  };
  const create = (request: AccessCreationRequest & { rowLinks?: unknown } = input(), writer = write) =>
    service.withCreatedRecords(ctx, mainIdentity, actor, request, writer);
  const unchanged = async () => {
    expect(await rows()).toEqual([]);
    expect(await through.model.count()).toBe(0);
  };

  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    projects = db.collection({
      name: 'projects',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'name', type: 'string' },
        { name: 'tenantId', type: 'string' },
      ],
    });
    through = db.collection({ name: 'document_projects', timestamps: false });
    docs = db.collection({
      name: 'documents',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true, autoIncrement: true },
        { name: 'name', type: 'string' },
        { name: 'tenantId', type: 'string' },
        { name: 'project', type: 'belongsTo', target: 'projects', foreignKey: 'projectId' },
        {
          name: 'projects',
          type: 'belongsToMany',
          target: 'projects',
          through: through.name,
          foreignKey: 'documentId',
          otherKey: 'targetId',
        },
      ],
    });
    db.collection({
      name: 'tenants',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'enabled', type: 'boolean' },
      ],
    });
    await db.sync();
    await db.getCollection('tenants').model.create({ id: 'B', enabled: true });
    for (const collection of [projects, through])
      await db
        .getRepository('collections')
        .create({ values: { name: collection.name, key: identity(collection).collectionKey } });
    await projects.model.bulkCreate([
      { id: 101, name: 'Visible', tenantId: 'H' },
      { id: 102, name: 'Hidden', tenantId: 'C' },
      { id: 103, name: 'Owned', tenantId: 'B' },
      { id: 104, name: 'Legacy', tenantId: null },
    ]);
    store = new AccessConfigStore(db, (value) =>
      resolveModelMetadata(db.getCollection(value.collectionName), {
        resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
      }),
    );
    await store.save(mainIdentity, { ...configFor(ownerCondition), revision: 0 }, { userId: 28 });
    const target = configFor(ownerCondition);
    target.rules.push({
      ...configFor(
        {
          type: 'any',
          children: [
            {
              type: 'compare',
              operator: 'eq',
              left: { type: 'field', path: 'name' },
              right: { type: 'literal', value: 'Visible' },
            },
            { type: 'isNull', operand: { type: 'field', path: 'tenantId' } },
          ],
        },
        'visibility',
      ).rules[0],
      id: 'visible-targets',
    });
    await store.save(identity(projects), { ...target, revision: 0 }, { userId: 28 });
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    service = new AccessCreationService(
      db,
      adapter,
      new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection))),
    );
    ctx = {};
    await adapter.prepare(ctx, [docs, projects, through].map(identity));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      if (dialect === 'postgres') await db?.sequelize.drop({ cascade: true });
    } finally {
      await db?.close();
    }
  });

  pg('binds distinct multi-value selections to each generated source without claiming targets', async () => {
    const before = (await projects.model.findAll({ order: [['id', 'ASC']] })).map((row) => row.get());
    await create();
    expect(await connections()).toEqual([
      { name: 'First', keys: [101, 104] },
      { name: 'Second', keys: [103] },
    ]);
    expect(await rows()).toMatchObject([{ tenantId: 'B' }, { tenantId: 'B' }]);
    expect((await projects.model.findAll({ order: [['id', 'ASC']] })).map((row) => row.get())).toEqual(before);
  });
  pg('gives the writer exactly one input row for each row-bound selection', async () => {
    await create(input(), async (plan) => {
      if (plan.values.length !== 1) throw new Error('Row-bound links require a single input per writer invocation');
      return write(plan);
    });
    expect(await connections()).toEqual([
      { name: 'First', keys: [101, 104] },
      { name: 'Second', keys: [103] },
    ]);
  });
  pg('supports row references and row links in the same atomic creation', async () => {
    await create({
      ...input(),
      rowReferences: [101, 103].map((key) => [{ association: 'project', target: identity(projects), key }]),
    });
    expect(await rows()).toMatchObject([
      { name: 'First', projectId: 101 },
      { name: 'Second', projectId: 103 },
    ]);
    expect(await connections()).toEqual([
      { name: 'First', keys: [101, 104] },
      { name: 'Second', keys: [103] },
    ]);
  });
  pg('rejects a later unreadable target without inserting any source', async () => {
    await expect(create({ ...input(), rowLinks: [[link([101])], [link([102])]] })).rejects.toMatchObject({
      code: 'ACCESS_RECORD_UNAVAILABLE',
    });
    await unchanged();
  });
  pg('keeps different target role conditions separate between rows', async () => {
    await expect(
      create({ ...input(), rowLinks: [[link([101], { name: 'Visible' })], [link([103], { name: 'Visible' })]] }),
    ).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    await unchanged();
  });
  pg('does not substitute source visibility for ownership', async () => {
    await store.save(
      mainIdentity,
      { ...configFor({ type: 'constant', value: true }, 'visibility'), revision: 1 },
      { userId: 28 },
    );
    adapter.release(ctx);
    await adapter.prepare(ctx, [docs, projects, through].map(identity));
    await expect(create()).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    await unchanged();
  });
  pg('rolls back earlier sources when the later writer throws its original error', async () => {
    const failure = new Error('Later batch row failed');
    let notified = false;
    docs.model.addHook('afterCreate', 'observe-commit', (_record, options) => {
      options.transaction!.afterCommit(() => {
        notified = true;
      });
    });
    docs.model.addHook('beforeCreate', 'fail-later-row', (record) => {
      if (record.get('name') === 'Second') throw failure;
    });
    await expect(create()).rejects.toBe(failure);
    await unchanged();
    expect(notified).toBe(false);
  });
  pg('keeps captured row selections detached from caller mutation during a writer await', async () => {
    const request = input();
    await create(request, async (plan) => {
      request.rowLinks[0][0].keys[0] = 102;
      request.rowLinks[1][0].keys[0] = 102;
      return write(plan);
    });
    expect(await connections()).toEqual([
      { name: 'First', keys: [101, 104] },
      { name: 'Second', keys: [103] },
    ]);
  });
  pg('rejects a writer returning a previous row model instead of this rows new insert', async () => {
    let first: Model | undefined;
    await expect(
      create(input(), async (plan) => {
        const [record] = await write(plan);
        first ??= record;
        return [first];
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    await unchanged();
  });
  pg('rechecks every earlier connections final state after later connection hooks', async () => {
    through.model.addHook('afterBulkCreate', 'alter-earlier-connection', async (records, options) => {
      const source = await docs.model.findByPk(records[0].get('documentId'), { transaction: options.transaction });
      if (source!.get('name') !== 'Second') return;
      const first = await docs.model.findOne({ where: { name: 'First' }, transaction: options.transaction });
      await through.model.destroy({ where: { documentId: first!.get('id') }, transaction: options.transaction });
    });
    await expect(create()).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    await unchanged();
  });
  pg('merges shared target authorization across more than twenty source rows', async () => {
    const request = {
      values: Array.from({ length: 25 }, (_, index) => ({ name: `Row ${index}` })),
      rowLinks: Array.from({ length: 25 }, () => [link([103])]),
    };
    let targetReads = 0;
    db.sequelize.addHook('afterQuery', 'count-linked-target-reads', (options) => {
      if (
        options.type === 'SELECT' &&
        (options as { model?: typeof projects.model }).model === projects.model &&
        (options as { lock?: string }).lock === Transaction.LOCK.SHARE
      )
        targetReads++;
    });
    expect(await create(request)).toMatchObject({ affected: 25 });
    expect(await through.model.count()).toBe(25);
    expect(targetReads).toBe(2);
  });
  it('keeps an empty per-row relationship selection usable as scalar creation', async () => {
    await create({ ...input(), rowLinks: [[], []] });
    expect(await rows()).toMatchObject([
      { name: 'First', tenantId: 'B' },
      { name: 'Second', tenantId: 'B' },
    ]);
    expect(await through.model.count()).toBe(0);
  });
  it('does not reuse an association cache for a different target or through identity', async () => {
    for (const field of ['target', 'through'] as const) {
      const request = input();
      request.rowLinks[1][0][field] = { ...request.rowLinks[1][0][field], collectionKey: 'different-key' };
      await expect(create(request)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      await unchanged();
    }
  });
  pg('rechecks a target made unreadable by connection hooks', async () => {
    through.model.addHook('afterBulkCreate', 'hide-target', async (_rows, options) => {
      await projects.model.update(
        { name: 'No longer visible' },
        { where: { id: 101 }, transaction: options.transaction },
      );
    });
    await expect(create()).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    await unchanged();
    expect((await projects.model.findByPk(101))!.get('name')).toBe('Visible');
  });
  pg('treats an omitted row association as an empty set when source hooks insert connections', async () => {
    docs.model.addHook('afterCreate', 'insert-omitted-connection', async (record, options) => {
      if (record.get('name') === 'Second')
        await through.model.create(
          { documentId: record.get('id'), targetId: 102 },
          { transaction: options.transaction },
        );
    });
    await expect(create({ ...input(), rowLinks: [[link([101])], []] })).rejects.toMatchObject({
      code: 'INVALID_ACCESS_MUTATION',
    });
    await unchanged();
  });
  pg('rechecks omitted row associations after caller persistence stages', async () => {
    const request = { ...input(), rowLinks: [[link([101])], []] };
    await expect(
      db.sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE }, async (transaction) =>
        service.withCreatedRecordsInTransaction(
          ctx,
          mainIdentity,
          actor,
          request,
          transaction,
          write,
          undefined,
          async () => {
            const second = await docs.model.findOne({ where: { name: 'Second' }, transaction });
            await through.model.create({ documentId: second!.get('id'), targetId: 102 }, { transaction });
          },
        ),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    await unchanged();
  });
  pg('keeps per-row key limits when a shared authorization group exceeds one thousand distinct targets', async () => {
    const keys = Array.from({ length: 1002 }, (_, index) => index + 1000);
    await projects.model.bulkCreate(keys.map((id) => ({ id, name: `Target ${id}`, tenantId: 'B' })));
    await create({ ...input(), rowLinks: [[link(keys.slice(0, 501))], [link(keys.slice(501))]] });
    expect(await through.model.count()).toBe(1002);
    expect(await connections()).toEqual([
      { name: 'First', keys: keys.slice(0, 501) },
      { name: 'Second', keys: keys.slice(501) },
    ]);
  });
  pg('rechecks earlier source ownership after later insert hooks', async () => {
    docs.model.addHook('afterCreate', 'move-earlier-row', async (record, options) => {
      if (record.get('name') === 'Second')
        await docs.model.update({ tenantId: 'C' }, { where: { name: 'First' }, transaction: options.transaction });
    });
    await expect(create()).rejects.toMatchObject({ code: 'ACCESS_OWNERSHIP_CHANGE_FORBIDDEN' });
    await unchanged();
  });
  pg('checks caller persistence stages before the caller commits', async () => {
    await expect(
      db.sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE }, async (transaction) =>
        service.withCreatedRecordsInTransaction(
          ctx,
          mainIdentity,
          actor,
          input(),
          transaction,
          write,
          undefined,
          async () => {
            await projects.model.update({ name: 'No longer visible' }, { where: { id: 101 }, transaction });
          },
        ),
      ),
    ).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    await unchanged();
  });
  it.runIf(dialect === 'sqlite')('rejects actual row links before using the unsupported writer', async () => {
    await expect(create()).rejects.toMatchObject({ code: 'UNSUPPORTED_ACCESS_MUTATION' });
    await unchanged();
  });
  for (const [name, matrix] of [
    ['null', () => null],
    ['missing row', () => [[link([101])]]],
    ['extra row', () => [[link([101])], [link([103])], []]],
    ['duplicate association', () => [[link([101]), link([103])], []]],
    ['sparse keys', () => [{ ...link([]), keys: Object.assign([], { length: 1 }) }].map((item) => [item]).concat([[]])],
    [
      'custom outer prototype',
      () => {
        const matrix = [[link([101])], [link([103])]];
        Object.setPrototypeOf(matrix, Object.create(Array.prototype));
        return matrix;
      },
    ],
    [
      'custom inner prototype',
      () => {
        const row = [link([101])];
        Object.setPrototypeOf(row, Object.create(Array.prototype));
        return [row, []];
      },
    ],
    ['too many fields', () => [Array.from({ length: 21 }, () => link([103])), []]],
    [
      'sparse',
      () => {
        const value = [[link([101])], [link([103])]];
        delete value[0];
        return value;
      },
    ],
  ] as const)
    it(`rejects ${name} row link matrices`, async () => {
      await expect(create({ ...input(), rowLinks: matrix() })).rejects.toMatchObject({
        code: 'INVALID_ACCESS_MUTATION',
      });
      await unchanged();
    });
  for (const field of ['links', 'references', 'reference'])
    it(`rejects row links mixed with legacy ${field}`, async () => {
      await expect(create({ ...input(), [field]: field === 'reference' ? null : [] })).rejects.toMatchObject({
        code: 'INVALID_ACCESS_MUTATION',
      });
      await unchanged();
    });
});

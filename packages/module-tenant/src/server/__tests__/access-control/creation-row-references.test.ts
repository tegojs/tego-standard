import { ACL, Transaction, type Collection, type Database, type Model } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import {
  AccessCreationService,
  type AccessCreationPlan,
  type AccessCreationReference,
} from '../../access-control/creation';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const projectIdentity = { ...mainIdentity, collectionName: 'projects', collectionKey: 'projects-key' };

/** The service consumes already-authorized entry values; this is not an action ACL fixture. */
describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('creation with per-row references (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let projects: Collection;
  let store: AccessConfigStore;
  let adapter: AccessAclScopeAdapter;
  let service: AccessCreationService;
  let ctx: object;
  const actor = { tenantId: 'B', userId: 28, roleName: 'importer' };
  const identity = (collection: Collection) => (collection === docs ? mainIdentity : projectIdentity);
  const ref = (key: number | null, where?: object): AccessCreationReference => ({
    association: 'project',
    target: projectIdentity,
    key,
    ...(where ? { where } : {}),
  });
  const input = () => ({
    values: [
      { id: 201, name: 'First' },
      { id: 202, name: 'Second' },
    ],
    rowReferences: [[ref(101)], [ref(103)]],
  });
  const rows = async () => (await docs.model.findAll({ order: [['id', 'ASC']] })).map((record) => record.get());
  const targetRows = async () =>
    (await projects.model.findAll({ order: [['id', 'ASC']] })).map((record) => record.get());
  const pg = (name: string, run: () => Promise<void>) => it.runIf(dialect === 'postgres')(name, run);
  const write = async (plan: AccessCreationPlan): Promise<Model[]> => {
    const saved: Model[] = [];
    for (const values of plan.values)
      saved.push(await docs.repository.create({ values, transaction: plan.transaction }));
    return saved;
  };
  const create = (request = input(), writer = write) =>
    service.withCreatedRecords(ctx, mainIdentity, actor, request, writer);

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
    docs = db.collection({
      name: 'documents',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'name', type: 'string' },
        { name: 'tenantId', type: 'string' },
        { name: 'project', type: 'belongsTo', target: 'projects', foreignKey: 'projectId' },
      ],
    });
    const tenants = db.collection({
      name: 'tenants',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'enabled', type: 'boolean' },
      ],
    });
    await tenants.model.sync();
    await tenants.model.create({ id: 'B', enabled: true });
    await projects.model.sync();
    await docs.model.sync();
    await projects.model.bulkCreate([
      { id: 101, name: 'Visible', tenantId: 'H' },
      { id: 102, name: 'Hidden', tenantId: 'C' },
      { id: 103, name: 'Owned', tenantId: 'B' },
      { id: 104, name: 'Legacy', tenantId: null },
    ]);
    await db.getRepository('collections').create({ values: { name: 'projects', key: 'projects-key' } });
    store = new AccessConfigStore(db, (key) =>
      resolveModelMetadata(db.getCollection(key.collectionName), {
        resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
      }),
    );
    const targetConfig = configFor(ownerCondition);
    targetConfig.rules.push({
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
    await store.save(mainIdentity, { ...configFor(ownerCondition), revision: 0 }, { userId: 28 });
    await store.save(projectIdentity, { ...targetConfig, revision: 0 }, { userId: 28 });
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    service = new AccessCreationService(
      db,
      adapter,
      new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection))),
    );
    ctx = {};
    await adapter.prepare(ctx, [mainIdentity, projectIdentity]);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      if (dialect === 'postgres') await db?.sequelize.drop({ cascade: true });
    } finally {
      await db?.close();
    }
  });

  pg('binds each created row to its own readable target and preserves the target owners', async () => {
    const targets = await targetRows();
    const request = input();
    request.values.push({ id: 203, name: 'Third' });
    request.rowReferences.push([ref(104)]);
    expect(await create(request)).toEqual({ keys: [201, 202, 203], affected: 3 });
    expect(await rows()).toMatchObject([
      { id: 201, projectId: 101, tenantId: 'B' },
      { id: 202, projectId: 103, tenantId: 'B' },
      { id: 203, projectId: 104, tenantId: 'B' },
    ]);
    expect(await targetRows()).toEqual(targets);
  });

  it.runIf(dialect === 'sqlite')(
    'rejects actual relation batches on SQLite instead of silently creating unrelated rows',
    async () => {
      await expect(create()).rejects.toMatchObject({ code: 'UNSUPPORTED_ACCESS_MUTATION' });
      expect(await rows()).toEqual([]);
    },
  );

  pg('rejects a hidden target in a later row without leaving any created rows', async () => {
    const request = input();
    request.rowReferences[1] = [ref(102)];
    await expect(create(request)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await rows()).toEqual([]);
  });

  pg('retains each row target role condition instead of reusing the first grant', async () => {
    const request = input();
    request.rowReferences = [[ref(101, { id: 101 })], [ref(103, { id: 101 })]];
    await expect(create(request)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await rows()).toEqual([]);
  });

  pg('supports null and omitted references per row without copying another rows selection', async () => {
    const request = input();
    request.rowReferences = [[ref(null)], []];
    await create(request);
    expect(await rows()).toMatchObject([
      { id: 201, projectId: null },
      { id: 202, projectId: null },
    ]);
  });

  pg('rejects source visibility without ownership and rolls back the complete batch', async () => {
    await store.save(
      mainIdentity,
      { ...configFor({ type: 'constant', value: true }, 'visibility'), revision: 1 },
      { userId: 28 },
    );
    adapter.release(ctx);
    await adapter.prepare(ctx, [mainIdentity, projectIdentity]);
    await expect(create()).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await rows()).toEqual([]);
  });

  pg('rolls back a writer swapping the expected target between rows', async () => {
    await expect(
      create(input(), async (plan) => {
        const values = plan.values.map((row, index) => ({ ...row, projectId: index ? 101 : 103 }));
        return write({ values, transaction: plan.transaction });
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await rows()).toEqual([]);
  });

  pg('rejects a reversed result order when it assigns references to different input rows', async () => {
    await expect(create(input(), async (plan) => (await write(plan)).reverse())).rejects.toMatchObject({
      code: 'INVALID_ACCESS_MUTATION',
    });
    expect(await rows()).toEqual([]);
  });

  pg('checks the earlier persisted row after a later hook changes its reference', async () => {
    docs.model.addHook('afterCreate', 'change-first-reference', async (record, options) => {
      if (record.get('id') === 202)
        await docs.model.update({ projectId: 103 }, { where: { id: 201 }, transaction: options.transaction });
    });
    await expect(create()).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await rows()).toEqual([]);
  });

  for (const mode of ['single', 'rows'])
    pg(`rechecks a ${mode} target after insert hooks make it unreadable`, async () => {
      docs.model.addHook('afterCreate', 'hide-target', async (_record, options) => {
        await projects.model.update(
          { name: 'Now hidden', tenantId: 'C' },
          { where: { id: 101 }, transaction: options.transaction },
        );
      });
      const request = mode === 'single' ? { values: [{ id: 201, name: 'First' }], reference: ref(101) } : input();
      await expect(service.withCreatedRecords(ctx, mainIdentity, actor, request, write)).rejects.toMatchObject({
        code: 'ACCESS_RECORD_UNAVAILABLE',
      });
      expect(await rows()).toEqual([]);
      expect((await projects.model.findByPk(101))!.get()).toMatchObject({ name: 'Visible', tenantId: 'H' });
    });

  pg('propagates the original later insert failure and suppresses commit notifications', async () => {
    const failure = new Error('Second row failed');
    let notified = false;
    docs.model.addHook('beforeCreate', 'fail-second', (record) => {
      if (record.get('id') === 202) throw failure;
    });
    await expect(
      create(input(), async (plan) => {
        plan.transaction.afterCommit(() => {
          notified = true;
        });
        return write(plan);
      }),
    ).rejects.toBe(failure);
    expect(await rows()).toEqual([]);
    expect(notified).toBe(false);
  });

  pg('rechecks role conditions against all persisted rows', async () => {
    await expect(
      service.withCreatedRecords(ctx, mainIdentity, actor, { ...input(), where: { name: 'First' } }, write),
    ).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await rows()).toEqual([]);
  });

  pg('leaves the final transaction decision to the caller', async () => {
    const failure = new Error('Caller rejects the import');
    await expect(
      db.sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE }, async (transaction) => {
        await service.withCreatedRecordsInTransaction(ctx, mainIdentity, actor, input(), transaction, write);
        expect(await docs.model.count({ transaction })).toBe(2);
        expect(await docs.model.count()).toBe(0);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await rows()).toEqual([]);
  });

  pg('supports more than twenty rows while bounding reference authorization queries', async () => {
    const request = {
      values: Array.from({ length: 25 }, (_, index) => ({ id: 201 + index, name: `Row ${index}` })),
      rowReferences: Array.from({ length: 25 }, () => [ref(103)]),
    };
    let targetReads = 0;
    db.sequelize.addHook('afterQuery', 'count-target-reads', (options) => {
      if (options.type === 'SELECT' && (options as { model?: typeof projects.model }).model === projects.model)
        targetReads++;
    });
    expect(await create(request)).toMatchObject({ affected: 25 });
    expect((await rows()).every((row) => row.projectId === 103 && row.tenantId === 'B')).toBe(true);
    expect(targetReads).toBe(2);
  });

  const invalidMatrices: Array<[string, () => unknown]> = [
    ['null', () => null],
    ['missing row', () => [[ref(101)]]],
    ['extra row', () => [[ref(101)], [ref(103)], []]],
    ['sparse outer array', () => Object.assign([], { length: 2, 0: [ref(101)] })],
    ['sparse inner array', () => [Object.assign([], { length: 1 }), []]],
    [
      'custom outer prototype',
      () => {
        const rows = [[ref(101)], [ref(103)]];
        Object.setPrototypeOf(rows, Object.create(Array.prototype));
        return rows;
      },
    ],
    [
      'custom inner prototype',
      () => {
        const row = [ref(101)];
        Object.setPrototypeOf(row, Object.create(Array.prototype));
        return [row, []];
      },
    ],
    ['duplicate relation', () => [[ref(101), ref(103)], []]],
    ['too many references', () => [Array.from({ length: 21 }, () => ref(101)), []]],
  ];
  it.each(invalidMatrices)('rejects %s row mappings without partial writes', async (_name, build) => {
    await expect(create({ ...input(), rowReferences: build() as AccessCreationReference[][] })).rejects.toMatchObject({
      code: 'INVALID_ACCESS_MUTATION',
    });
    expect(await rows()).toEqual([]);
  });

  it.each(['reference', 'references', 'links'])('rejects ambiguous row references combined with %s', async (name) => {
    const request = { ...input(), [name]: name === 'reference' ? ref(101) : [] };
    await expect(create(request)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await rows()).toEqual([]);
  });

  it('preserves rejection of an invalid legacy reference list instead of treating it as omitted', async () => {
    await expect(
      service.withCreatedRecords(
        ctx,
        mainIdentity,
        actor,
        { values: [{ id: 201, name: 'Invalid legacy selection' }], references: null },
        write,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await rows()).toEqual([]);
  });
});

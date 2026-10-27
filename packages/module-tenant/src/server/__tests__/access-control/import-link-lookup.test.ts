import { ACL, Resourcer, Transaction, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { AccessCreationService } from '../../access-control/creation';
import { AccessImportReferenceLookup } from '../../access-control/import-reference-lookup';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('authorized import link lookup (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let projects: Collection;
  let through: Collection;
  let adapter: AccessAclScopeAdapter;
  let queries: AccessQueryService;
  const actor = { tenantId: 'B', roleName: 'importer', userId: 28 };
  const identity = (collection: Collection) =>
    collection === docs
      ? mainIdentity
      : { ...mainIdentity, collectionName: collection.name, collectionKey: `${collection.name}-key` };
  const targets = async () => (await projects.model.findAll({ order: [['id', 'ASC']] })).map((row) => row.get());

  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    projects = db.collection({
      name: 'projects',
      timestamps: false,
      fields: [
        { name: 'id', type: 'bigInt', primaryKey: true },
        { name: 'name', type: 'string' },
        { name: 'tenantId', type: 'string' },
        { name: 'code', type: 'integer' },
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
      { id: 101, name: 'Owned', code: 1, tenantId: 'B' },
      { id: 102, name: 'Visible', code: 2, tenantId: 'H' },
      { id: 103, name: 'Hidden', code: 3, tenantId: 'C' },
      { id: 104, name: 'Legacy', code: 4, tenantId: null },
    ]);
    const store = new AccessConfigStore(db, (value) =>
      resolveModelMetadata(db.getCollection(value.collectionName), {
        resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
      }),
    );
    await store.save(mainIdentity, { ...configFor(ownerCondition), revision: 0 }, { userId: 28 });
    const config = configFor(ownerCondition);
    config.rules.push({
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
      id: 'visible',
    });
    await store.save(identity(projects), { ...config, revision: 0 }, { userId: 28 });
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    queries = new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection)));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      if (dialect === 'postgres') await db?.sequelize.drop({ cascade: true });
    } finally {
      await db?.close();
    }
  });
  async function context(resource = 'documents', actionName = 'importXlsx', grant: object = {}, params: object = {}) {
    const acl = new ACL();
    acl.setAvailableAction('importXlsx', { type: 'new-data' });
    acl.setAvailableAction('list', {});
    acl.define({ role: 'importer' }).grantAction(`${resource}:${actionName}`, grant);
    const router = new Resourcer();
    router.define({ name: resource, actions: { importXlsx: {}, list: {} } });
    const action = router.getAction(resource, actionName).clone();
    Object.assign(action, { resourceName: resource, actionName });
    action.mergeParams({ resourceName: resource, actionName, ...params });
    const ctx = {
      db,
      action,
      state: { currentRole: 'importer', currentUser: { id: 28 } },
      get: () => '+08:00',
      logger: { info: () => {} },
      throw: (status: number) => {
        throw new Error(String(status));
      },
      permission: undefined as unknown,
    };
    await adapter.prepare(ctx, [docs, projects, through].map(identity));
    await acl.middleware()(ctx as never, async () => {});
    return ctx;
  }
  async function prepare(
    options: {
      sourceFields?: string[];
      fields?: string[];
      lookup?: string;
      filter?: object;
      authorize?: () => Promise<unknown>;
    } = {},
  ) {
    const ctx = await context('documents', 'importXlsx', { fields: options.sourceFields ?? ['projects'] });
    const lookup = new AccessImportReferenceLookup(db, adapter, queries, identity);
    const plan = lookup.prepareLinks(
      ctx,
      mainIdentity,
      actor,
      [{ dataIndex: ['projects', options.lookup ?? 'name'], defaultTitle: 'Projects' }],
      options.authorize ??
        (() =>
          context('projects', 'list', {
            fields: options.fields ?? ['id', 'name', 'code'],
            ...(options.filter ? { filter: options.filter } : {}),
          })),
    );
    return { ctx, plan };
  }
  it('resolves semicolon-separated readable targets per row without changing or claiming them', async () => {
    const before = await targets();
    const { plan } = await prepare();
    const rows = await plan.resolve([[' Owned ; Visible ;Legacy '], ['Visible']]);
    expect(
      rows.map((row) =>
        row.map((link) => ({
          association: link.association,
          keys: link.keys,
          target: link.target,
          through: link.through,
        })),
      ),
    ).toEqual([
      [
        {
          association: 'projects',
          keys: ['101', '102', '104'],
          target: identity(projects),
          through: identity(through),
        },
      ],
      [{ association: 'projects', keys: ['102'], target: identity(projects), through: identity(through) }],
    ]);
    expect(await targets()).toEqual(before);
    expect(await docs.model.count()).toBe(0);
    expect(await through.model.count()).toBe(0);
  });
  it('keeps blank cells as explicit empty selections', async () => {
    const { plan } = await prepare();
    expect((await plan.resolve([[null], ['  ']])).map((row) => row[0].keys)).toEqual([[], []]);
  });
  it.each(['Owned;Hidden', 'Owned;Missing'])(
    'rejects the whole selection when any target is unavailable: %s',
    async (value) => {
      const { plan } = await prepare();
      await expect(plan.resolve([[value]])).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      expect(await through.model.count()).toBe(0);
    },
  );
  it('rejects ambiguous readable matches instead of taking the first', async () => {
    await projects.model.create({ id: 105, name: 'Owned', tenantId: 'B' });
    const { plan } = await prepare();
    await expect(plan.resolve([['Owned;Visible']])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });
  it('does not count hidden namesakes as readable matches', async () => {
    await projects.model.create({ id: 105, name: 'Owned', tenantId: 'C' });
    const { plan } = await prepare();
    expect((await plan.resolve([['Owned;Visible']]))[0][0].keys).toEqual(['101', '102']);
  });
  it('applies target role filters independently from G or V', async () => {
    const { plan } = await prepare({ filter: { code: 1 } });
    await expect(plan.resolve([['Owned;Visible']])).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
  });
  it.each([['id'], ['name']])('requires both key and lookup field read permissions: %j', async (fields) => {
    const { plan } = await prepare({ fields });
    await expect(plan.resolve([['Owned']])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });
  it('authorizes target operations before parsing any cell', async () => {
    let parsed = false;
    const Parser = db.fieldValueParsers.get('string');
    db.registerFieldValueParsers({
      string: class extends Parser {
        async setValue(value: unknown) {
          parsed = true;
          await super.setValue(value);
        }
      },
    });
    const { plan } = await prepare({ authorize: async () => null });
    await expect(plan.resolve([['Owned']])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(parsed).toBe(false);
  });
  it('rejects source columns outside the import field permission', async () => {
    await expect(prepare({ sourceFields: ['name'] })).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });
  it.each(['Owned;;Visible', 'Owned;', ';Owned', 'Owned; Owned'])(
    'rejects malformed or repeated selections: %s',
    async (value) => {
      const { plan } = await prepare();
      await expect(plan.resolve([[value]])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    },
  );
  it('rejects more than one thousand selections before resolving a target', async () => {
    const { plan } = await prepare();
    await expect(
      plan.resolve([[Array.from({ length: 1001 }, (_, index) => `Name ${index}`).join(';')]]),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });
  it('rejects an expanded file over the existing complexity budget before any target query', async () => {
    const { plan } = await prepare();
    let reads = 0;
    db.sequelize.addHook('afterQuery', 'count-import-target-reads', (options) => {
      if (options.type === 'SELECT' && (options as { model?: typeof projects.model }).model === projects.model) reads++;
    });
    const cell = Array.from({ length: 1000 }, (_, index) => `Target ${index}`).join(';');
    await expect(plan.resolve(Array.from({ length: 11 }, () => [cell]))).rejects.toMatchObject({
      code: 'INVALID_ACCESS_MUTATION',
    });
    expect(reads).toBe(0);
  });
  it('uses the registered scalar parser for each numeric display value', async () => {
    await projects.model.update({ code: 1000 }, { where: { id: 101 } });
    const { plan } = await prepare({ lookup: 'code' });
    expect((await plan.resolve([['1,000;2']]))[0][0].keys).toEqual(['101', '102']);
  });
  it('rejects duplicate normalized keys even when the display values differ', async () => {
    const { plan } = await prepare({ lookup: 'id', fields: ['id'] });
    await expect(plan.resolve([['101;00101']])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });
  it('checks relation scope for every selected target', async () => {
    (docs.model.associations.projects as unknown as { scope: object }).scope = { code: 1 };
    const { plan } = await prepare();
    await expect(plan.resolve([['Owned;Visible']])).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
  });
  it('rejects join tables with business fields before target authorization', async () => {
    through.setField('amount', { type: 'integer' });
    await expect(prepare()).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });
  it('rechecks join metadata during independent target authorization', async () => {
    const { plan } = await prepare({
      authorize: async () => {
        through.setField('amount', { type: 'integer' });
        return context('projects', 'list', { fields: ['id', 'name'] });
      },
    });
    await expect(plan.resolve([['Owned']])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });
  it('does not reuse a resolved lookup plan', async () => {
    const { plan } = await prepare();
    await plan.resolve([['Owned']]);
    await expect(plan.resolve([['Visible']])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });
  it.runIf(dialect === 'postgres')('passes exact large primary keys through without numeric rounding', async () => {
    await projects.model.create({ id: '9007199254740993', name: 'Large key', tenantId: 'B' });
    const { plan } = await prepare({ lookup: 'id', fields: ['id'] });
    expect((await plan.resolve([['9007199254740993;101']]))[0][0].keys).toEqual(['9007199254740993', '101']);
  });
  it.runIf(dialect === 'postgres')(
    'binds resolved row selections in the caller transaction and rolls back all rows',
    async () => {
      const before = await targets();
      const { ctx, plan } = await prepare();
      await plan.authorizeTargets();
      const rollback = new Error('Caller rollback');
      await expect(
        db.sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE }, async (transaction) => {
          const rowLinks = await plan.resolve([['Owned;Visible'], ['Legacy']], transaction);
          await new AccessCreationService(db, adapter, queries).withCreatedRecordsInTransaction(
            ctx,
            mainIdentity,
            actor,
            { values: [{ name: 'First' }, { name: 'Second' }], rowLinks },
            transaction,
            async (write) => [await docs.repository.create({ values: write.values[0], transaction })],
            plan.assertCurrent,
          );
          expect(await through.model.count({ transaction })).toBe(3);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect(await docs.model.count()).toBe(0);
      expect(await through.model.count()).toBe(0);
      expect(await targets()).toEqual(before);
    },
  );
});

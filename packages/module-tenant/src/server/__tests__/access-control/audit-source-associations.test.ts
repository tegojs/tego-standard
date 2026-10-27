import { mockServer, type MockServer } from '@tachybase/test';
import { ACL, type Collection } from '@tego/server';

import UsersPlugin from '../../../../../module-user/src/server/server';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { AccessBelongsToService } from '../../access-control/belongs-to';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { AccessManyToManyService } from '../../access-control/many-to-many';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessMutationService, type ExistingAccessWritePlan } from '../../access-control/mutation';
import { AccessQueryService } from '../../access-control/query';
import { AccessReferenceService } from '../../access-control/references';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

/** Trusted service inputs only. Final operation/field ACL remains the calling entry's responsibility. */
describe.skipIf(!postgresUrl)('source association writes with framework audit fields', () => {
  let app: MockServer;
  let docs: Collection;
  let projects: Collection;
  let through: Collection;
  let adapter: AccessAclScopeAdapter;
  let belongsTo: AccessBelongsToService;
  let manyToMany: AccessManyToManyService;
  const actor = { tenantId: 'B', userId: 28, roleName: 'editor' };
  const ctx = { state: { currentUser: { id: 28 }, currentRole: 'editor' } };
  const identity = (collection: Collection) =>
    collection === docs
      ? mainIdentity
      : {
          ...mainIdentity,
          collectionName: collection.name,
          collectionKey: `${collection.name}-key`,
        };
  beforeEach(async () => {
    const isolated = isolatedPostgresDatabase(postgresUrl!);
    const database = { ...isolated.options };
    await isolated.close();
    app = mockServer({ acl: false, database });
    await new UsersPlugin(app, { name: 'audit-source-users' }).beforeLoad();
    const db = app.db;
    db.collection({
      name: 'users',
      timestamps: false,
      createdBy: true,
      updatedBy: true,
      fields: [{ name: 'id', type: 'bigInt', primaryKey: true }],
    });
    await seedConfigStore(db);
    await seedAclScopes(db);
    const fields = [
      { name: 'id', type: 'integer', primaryKey: true },
      { name: 'name', type: 'string' },
      { name: 'tenantId', type: 'string' },
    ];
    projects = db.collection({ name: 'projects', timestamps: false, createdBy: true, updatedBy: true, fields });
    through = db.collection({ name: 'document_projects', timestamps: false });
    docs = db.collection({
      name: 'documents',
      timestamps: false,
      createdBy: true,
      updatedBy: true,
      fields: [
        ...fields,
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
    await db.getCollection('users').model.bulkCreate([{ id: 28 }, { id: 29 }, { id: 30 }]);
    await db.getCollection('tenants').model.create({ id: 'B', enabled: true });
    for (const collection of [projects, through])
      await db.getRepository('collections').create({
        values: {
          name: collection.name,
          key: identity(collection).collectionKey,
        },
      });
    const previous = { state: { currentUser: { id: 29 } } };
    for (const values of [
      { id: 101, name: 'Visible', tenantId: 'H' },
      { id: 102, name: 'Hidden', tenantId: 'C' },
      { id: 103, name: 'Owned', tenantId: 'B' },
      { id: 104, name: 'Legacy', tenantId: null },
    ])
      await projects.repository.create({ values, context: previous });
    for (const values of [
      { id: 1, name: 'Before', tenantId: 'B' },
      { id: 2, name: 'Legacy source', tenantId: null, projectId: 101 },
      { id: 3, name: 'Visible source', tenantId: 'H' },
    ])
      await docs.repository.create({ values, context: previous });
    const store = new AccessConfigStore(db, (value) =>
      resolveModelMetadata(db.getCollection(value.collectionName), {
        resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
      }),
    );
    const config = configFor({
      type: 'any',
      children: [ownerCondition, { type: 'isNull', operand: { type: 'field', path: 'tenantId' } }],
    });
    config.rules.push({
      ...configFor({ type: 'constant', value: true }, 'visibility').rules[0],
      id: 'source-readable',
    });
    await store.save(mainIdentity, { ...config, revision: 0 }, { userId: 28 });
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
      id: 'target-readable',
    });
    await store.save(identity(projects), { ...targetConfig, revision: 0 }, { userId: 28 });
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    const queries = new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection)));
    const mutations = new AccessMutationService(db, adapter, queries);
    const references = new AccessReferenceService(db, adapter, queries);
    belongsTo = new AccessBelongsToService(db, adapter, queries, mutations, references);
    manyToMany = new AccessManyToManyService(db, adapter, queries, mutations, references);
    await adapter.prepare(ctx, [docs, projects, through].map(identity));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    adapter?.release(ctx);
    try {
      await app?.db.sequelize.drop({ cascade: true });
    } finally {
      await app?.destroy();
    }
  });
  const writer = async (plan: ExistingAccessWritePlan) => {
    for (const row of plan.records)
      await docs.repository.update({
        filterByTk: row.get('id'),
        values: plan.valuesFor(row),
        transaction: plan.transaction,
        context: ctx,
      });
  };
  const entry = () => ({ assertCurrent: () => {}, targetScope: async () => ({}) });
  const reference = (id: number, targetKey: number | null, sourceValues?: object) =>
    belongsTo.withReference(
      ctx,
      mainIdentity,
      identity(projects),
      actor,
      { association: 'project', sourceKeys: [id], targetKey, ...(sourceValues ? { sourceValues } : {}) },
      writer,
      entry(),
    );
  const links = (id: number, keys: number[], sourceValues?: object, lifecycle = false) =>
    manyToMany.withLinkSets(
      ctx,
      mainIdentity,
      actor,
      {
        sourceKeys: [id],
        ...(sourceValues ? { sourceValues } : {}),
        links: [
          {
            association: 'projects',
            target: identity(projects),
            through: identity(through),
            operation: 'set',
            targetKeys: keys,
          },
        ],
      },
      { ...entry(), ...(lifecycle ? { afterPersist: async () => {} } : {}) },
    );
  const targets = async () => (await projects.model.findAll({ order: [['id', 'ASC']] })).map((row) => row.get());
  const source = async (id = 1) => (await docs.model.findByPk(id))!.get();

  it('changes a single reference and scalar values with native modifier maintenance', async () => {
    const before = await targets();
    expect(await reference(1, 101, { name: 'After' })).toMatchObject({ affected: 1 });
    expect(await source()).toMatchObject({
      name: 'After',
      projectId: 101,
      createdById: 29,
      updatedById: 28,
      tenantId: 'B',
    });
    expect(await targets()).toEqual(before);
  });
  it('clears a single reference while preserving the original creator', async () => {
    await reference(2, null);
    expect(await source(2)).toMatchObject({ projectId: null, createdById: 29, updatedById: 28, tenantId: 'B' });
  });
  it('keeps an unchanged legacy reference unclaimed without touching its audit fields', async () => {
    expect(await reference(2, 101)).toMatchObject({ affected: 0 });
    expect(await source(2)).toMatchObject({ tenantId: null, createdById: 29, updatedById: 29 });
  });
  it('writes pure links and a scalar patch without modifying referenced targets', async () => {
    const before = await targets();
    expect(await links(1, [101, 104], { name: 'After' })).toMatchObject({ affected: 1 });
    expect(await source()).toMatchObject({ name: 'After', createdById: 29, updatedById: 28 });
    expect(await through.model.count()).toBe(2);
    expect(await targets()).toEqual(before);
  });
  it('permits native modifier maintenance during an explicit link-only lifecycle', async () => {
    await links(1, [101], undefined, true);
    expect(await source()).toMatchObject({ createdById: 29, updatedById: 28 });
    expect(await through.model.count()).toBe(1);
  });
  it('leaves an empty legacy link selection untouched and unclaimed', async () => {
    expect(await links(2, [], undefined, true)).toMatchObject({ affected: 0 });
    expect(await source(2)).toMatchObject({ tenantId: null, createdById: 29, updatedById: 29 });
  });
  it.each(['reference', 'links'])('keeps V-only sources unwritable for %s', async (mode) => {
    await expect(mode === 'reference' ? reference(3, 101) : links(3, [101], { name: 'After' })).rejects.toMatchObject({
      code: 'ACCESS_RECORD_UNAVAILABLE',
    });
    expect(await source(3)).toMatchObject({ tenantId: 'H', createdById: 29, updatedById: 29 });
    expect(await through.model.count()).toBe(0);
  });
  it.each(['reference', 'links'])(
    'rejects hidden target selections for %s without changing audit data',
    async (mode) => {
      await expect(mode === 'reference' ? reference(1, 102) : links(1, [102], { name: 'After' })).rejects.toMatchObject(
        { code: 'ACCESS_RECORD_UNAVAILABLE' },
      );
      expect(await source()).toMatchObject({ name: 'Before', createdById: 29, updatedById: 29 });
      expect(await through.model.count()).toBe(0);
    },
  );
  it.each(['reference', 'links'])('rolls back a hook forging the creator during %s', async (mode) => {
    docs.model.addHook('afterUpdate', 'forge-creator', async (row, options) => {
      await docs.model.update(
        { createdById: 30 },
        { where: { id: row.get('id') }, transaction: options.transaction, hooks: false },
      );
    });
    await expect(mode === 'reference' ? reference(1, 101) : links(1, [101], { name: 'After' })).rejects.toMatchObject({
      code: 'INVALID_ACCESS_MUTATION',
    });
    expect(await source()).toMatchObject({ name: 'Before', projectId: null, createdById: 29, updatedById: 29 });
    expect(await through.model.count()).toBe(0);
  });
});

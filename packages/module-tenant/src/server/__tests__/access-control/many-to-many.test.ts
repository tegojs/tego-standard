import { ACL, literal, Transaction, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { AccessManyToManyService } from '../../access-control/many-to-many';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessMutationService } from '../../access-control/mutation';
import { AccessQueryService } from '../../access-control/query';
import { AccessReferenceService } from '../../access-control/references';
import type { AccessConfig } from '../../access-control/types';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const target = { dataSourceKey: 'main', collectionKey: 'projects-key', collectionName: 'projects' };
const throughIdentity = {
  dataSourceKey: 'main',
  collectionKey: 'documentProjects-key',
  collectionName: 'documentProjects',
};
const authenticated = { tenantId: 'B' };
const stableKey = (collection: Collection) =>
  accessCollectionKey({ ...mainIdentity, collectionKey: `${collection.name}-key`, collectionName: collection.name });

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('access many-to-many (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let projects: Collection;
  let through: Collection;
  let store: AccessConfigStore;
  let adapter: AccessAclScopeAdapter;
  let queries: AccessQueryService;
  let links: AccessManyToManyService;
  let ctx: object;

  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl) : sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    const fields = [
      { name: 'id', type: 'integer', primaryKey: true },
      { name: 'tenantId', type: 'string' },
      { name: 'name', type: 'string' },
    ];
    docs = db.collection({ name: 'documents', tableName: 'm2m_documents', timestamps: false, fields });
    projects = db.collection({ name: 'projects', tableName: 'm2m_projects', timestamps: false, fields });
    through = db.collection({ name: 'documentProjects', tableName: 'm2m_links', timestamps: false });
    docs.setField('projects', {
      type: 'belongsToMany',
      target: 'projects',
      through: 'documentProjects',
      foreignKey: 'documentId',
      otherKey: 'projectId',
    });
    const tenants = db.collection({
      name: 'tenants',
      tableName: 'm2m_tenants',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'parentId', type: 'string' },
        { name: 'enabled', type: 'boolean' },
      ],
    });
    await db.sync();
    await tenants.repository.create({
      values: [
        { id: 'H', parentId: null, enabled: true },
        { id: 'B', parentId: 'H', enabled: true },
        { id: 'C', parentId: 'H', enabled: true },
      ],
    });
    await docs.repository.create({
      values: [
        { id: 1, tenantId: 'H', name: 'Shared' },
        { id: 3, tenantId: 'B', name: 'Owned' },
        { id: 4, tenantId: 'C', name: 'Hidden' },
        { id: 5, tenantId: null, name: 'Legacy' },
      ],
    });
    await projects.repository.create({
      values: [
        { id: 101, tenantId: 'H', name: 'Shared' },
        { id: 102, tenantId: 'C', name: 'Hidden' },
        { id: 103, tenantId: 'B', name: 'Owned' },
        { id: 104, tenantId: null, name: 'Legacy' },
      ],
    });
    await db.getRepository('collections').create({ values: { key: 'projects-key', name: 'projects' } });
    await db
      .getRepository('collections')
      .create({ values: { key: throughIdentity.collectionKey, name: throughIdentity.collectionName } });
    store = new AccessConfigStore(db, (identity) =>
      resolveModelMetadata(db.getCollection(identity.collectionName), { resolveCollectionKey: stableKey }),
    );
    const config: AccessConfig = {
      ...configFor(ownerCondition),
      revision: 0,
      rules: [
        ...configFor(ownerCondition).rules,
        {
          ...configFor(
            {
              type: 'any',
              children: [
                {
                  type: 'compare',
                  operator: 'eq',
                  left: { type: 'field', path: 'name' },
                  right: { type: 'literal', value: 'Shared' },
                },
                { type: 'isNull', operand: { type: 'field', path: 'tenantId' } },
              ],
            },
            'visibility',
          ).rules[0],
          id: 'read-shared',
        },
      ],
    };
    await store.save(mainIdentity, config, { userId: 28 });
    await store.save(target, config, { userId: 28 });
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    queries = new AccessQueryService(db, adapter, stableKey);
    links = new AccessManyToManyService(
      db,
      adapter,
      queries,
      new AccessMutationService(db, adapter, queries),
      new AccessReferenceService(db, adapter, queries),
    );
    ctx = {};
    await adapter.prepare(ctx, [mainIdentity, target, throughIdentity]);
  });

  afterEach(async () => {
    try {
      if (dialect === 'postgres')
        await db.sequelize.query(
          'DROP TABLE IF EXISTS "rolesResourcesScopesActions", "dataSourcesRolesResourcesScopesActions", ' +
            '"rolesResourcesScopes", "dataSourcesRolesResourcesScopes", "access_config_collections", ' +
            '"access_config_dataSourcesCollections", "tenantAccessRevisions", "m2m_links", ' +
            '"m2m_documents", "m2m_projects", "m2m_tenants", "m2m_hidden_documents", "m2m_readers", "m2m_link_notes"',
        );
    } finally {
      await db.close();
    }
  });

  const mutate = (
    operation: 'add' | 'remove' | 'set',
    sourceKeys: number[],
    targetKeys: Array<string | number>,
    extra = {},
  ) =>
    links.withLinks(ctx, mainIdentity, target, throughIdentity, authenticated, {
      association: 'projects',
      operation,
      sourceKeys,
      targetKeys,
      ...extra,
    });

  async function linked(source = 3) {
    const rows = await through.model.findAll({
      attributes: ['documentId', 'projectId'],
      where: { documentId: source },
      order: [['projectId', 'ASC']],
    });
    return rows.map((row) => row.getDataValue('projectId'));
  }

  async function configure(config: AccessConfig) {
    await store.save(mainIdentity, { ...config, revision: (await store.read(mainIdentity)).revision }, { userId: 28 });
    adapter.release(ctx);
    await adapter.prepare(ctx, [mainIdentity, target, throughIdentity]);
  }

  if (dialect === 'sqlite') {
    it('rejects relationship writes on unvalidated dialects', async () => {
      await expect(mutate('add', [3], [101])).rejects.toMatchObject({ code: 'UNSUPPORTED_ACCESS_MUTATION' });
      expect(await linked()).toEqual([]);
    });
    return;
  }

  it('links visibility-only and legacy targets without changing their ownership', async () => {
    expect(await mutate('add', [3], [101, 104])).toEqual({ keys: [3], affected: 1 });
    expect(await linked()).toEqual([101, 104]);
    expect((await projects.model.findByPk(101)).getDataValue('tenantId')).toBe('H');
    expect((await projects.model.findByPk(104)).getDataValue('tenantId')).toBeNull();
  });

  it('rejects the whole batch when a source is visibility-only or hidden', async () => {
    for (const key of [1, 4]) {
      await expect(mutate('add', [3, key], [101])).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      expect(await linked()).toEqual([]);
    }
  });

  it('rejects hidden and missing explicit targets before changing any connection', async () => {
    for (const key of [102, 999]) {
      await expect(mutate('set', [3], [101, key])).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      expect(await linked()).toEqual([]);
    }
  });

  it('intersects source and target role predicates', async () => {
    await expect(mutate('add', [3], [101], { sourceWhere: { name: 'Hidden' } })).rejects.toThrow();
    await expect(mutate('add', [3], [101], { targetWhere: { name: 'Owned' } })).rejects.toThrow();
    expect(await linked()).toEqual([]);
  });

  it('deduplicates keys and implements add remove and empty set', async () => {
    await mutate('add', [3, 3], [101, '0101', 103]);
    expect(await linked()).toEqual([101, 103]);
    await mutate('remove', [3], [101]);
    expect(await linked()).toEqual([103]);
    await mutate('set', [3], []);
    expect(await linked()).toEqual([]);
    expect(await projects.model.count()).toBe(4);
  });

  it('removes hidden old connections during set without editing old targets', async () => {
    await through.repository.create({ values: { documentId: 3, projectId: 102 } });
    await mutate('set', [3], [101]);
    expect(await linked()).toEqual([101]);
    expect((await projects.model.findByPk(102)).getDataValue('tenantId')).toBe('C');
  });

  it('claims a historical source only when its connection actually changes', async () => {
    docs.setField('tenant', { type: 'belongsTo', target: 'tenants', foreignKey: 'tenantId' });
    await configure(configFor({ type: 'isNull', operand: { type: 'field', path: 'tenantId' } }));
    expect(await mutate('remove', [5], [101])).toEqual({ keys: [], affected: 0 });
    expect((await docs.model.findByPk(5)).getDataValue('tenantId')).toBeNull();
    expect(await mutate('set', [5], [])).toEqual({ keys: [], affected: 0 });
    expect((await docs.model.findByPk(5)).getDataValue('tenantId')).toBeNull();
    expect(await mutate('add', [5], [104])).toEqual({ keys: [5], affected: 1 });
    expect((await docs.model.findByPk(5)).getDataValue('tenantId')).toBe('B');
    expect((await projects.model.findByPk(104)).getDataValue('tenantId')).toBeNull();
  });

  it('does not claim a historical source when set keeps the same connection', async () => {
    await configure(configFor({ type: 'isNull', operand: { type: 'field', path: 'tenantId' } }));
    await through.repository.create({ values: { documentId: 5, projectId: 104 } });
    expect(await mutate('set', [5], [104])).toEqual({ keys: [], affected: 0 });
    expect((await docs.model.findByPk(5)).getDataValue('tenantId')).toBeNull();
  });

  it('rejects a historical source matched only by visibility', async () => {
    await expect(mutate('add', [5], [104])).rejects.toMatchObject({ code: 'LEGACY_DATA_READ_ONLY' });
    expect(await linked(5)).toEqual([]);
    expect((await docs.model.findByPk(5)).getDataValue('tenantId')).toBeNull();
  });

  it('allows the successful connection change to leave the old ownership condition', async () => {
    await through.repository.create({ values: { documentId: 3, projectId: 103 } });
    await configure(
      configFor({
        type: 'exists',
        path: 'projects',
        condition: {
          type: 'compare',
          operator: 'eq',
          left: { type: 'field', path: 'name' },
          right: { type: 'literal', value: 'Owned' },
        },
      }),
    );
    expect(await mutate('set', [3], [101])).toEqual({ keys: [3], affected: 1 });
    expect(await linked()).toEqual([101]);
    await expect(mutate('set', [3], [103])).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
  });

  it('keeps named source and target bindings separate', async () => {
    await mutate('add', [3], [101], {
      sourceWhere: literal('"documents"."name" = $tac_scope0_name'),
      sourceBind: { tac_scope0_name: 'Owned' },
      targetWhere: literal('"projects"."name" = $tac_scope0_name'),
      targetBind: { tac_scope0_name: 'Shared' },
    });
    expect(await linked()).toEqual([101]);
  });

  it.each(['add', 'remove', 'set'] as const)('rejects hidden explicit targets in %s', async (operation) => {
    await through.repository.create({ values: { documentId: 3, projectId: 102 } });
    await expect(mutate(operation, [3], [102])).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await linked()).toEqual([102]);
  });

  it.each(['tenantId', 'amount'])('rejects a business through table containing %s', async (field) => {
    through.setField(field, { type: field === 'amount' ? 'integer' : 'string' });
    await expect(mutate('add', [3], [101])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await linked()).toEqual([]);
  });

  it.each(['throughValues', 'values'])(
    'rejects unsupported input %s rather than silently accepting it',
    async (field) => {
      await expect(mutate('add', [3], [101], { [field]: { tenantId: 'C' } })).rejects.toMatchObject({
        code: 'INVALID_ACCESS_MUTATION',
      });
      expect(await linked()).toEqual([]);
    },
  );

  it('rejects non-primary relation keys and scoped join tables', async () => {
    const association = docs.model.associations.projects as typeof docs.model.associations.projects & {
      sourceKey: string;
      through: { scope?: object };
    };
    association.sourceKey = 'name';
    await expect(mutate('add', [3], [101])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    association.sourceKey = 'id';
    association.through.scope = { documentId: 3 };
    await expect(mutate('add', [3], [101])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    delete association.through.scope;
    through.model.addScope('defaultScope', { where: { documentId: 3 } }, { override: true });
    await expect(mutate('add', [3], [101])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });

  it('rejects unprepared and cross-data-source references', async () => {
    await expect(
      links.withLinks({}, mainIdentity, target, throughIdentity, authenticated, {
        association: 'projects',
        operation: 'add',
        sourceKeys: [3],
        targetKeys: [101],
      }),
    ).rejects.toThrow();
    await expect(
      links.withLinks(ctx, mainIdentity, { ...target, dataSourceKey: 'external' }, throughIdentity, authenticated, {
        association: 'projects',
        operation: 'add',
        sourceKeys: [3],
        targetKeys: [101],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });

  it('rejects invalid keys operations and excessive batches', async () => {
    for (const extra of [
      { sourceKeys: [] },
      { sourceKeys: ['_'] },
      { targetKeys: ['_'] },
      { targetKeys: [[101, {}]] },
      { operation: 'destroy' },
      {
        sourceKeys: Array.from({ length: 101 }, (_, i) => i + 1),
        targetKeys: Array.from({ length: 100 }, (_, i) => i + 100),
      },
    ])
      await expect(mutate('add', [3], [101], extra)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await linked()).toEqual([]);
  });

  it('rolls back wrong connections written by a hook without notifying after commit', async () => {
    const notified = vi.fn();
    through.model.addHook('afterBulkCreate', async (_rows, options) => {
      options.transaction.afterCommit(notified);
      await through.model.update({ projectId: 103 }, { where: { documentId: 3 }, transaction: options.transaction });
    });
    await expect(mutate('add', [3], [101])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await linked()).toEqual([]);
    expect(notified).not.toHaveBeenCalled();
  });

  it('rejects extra unauthorized sources appended to the actual bulk insert by a hook', async () => {
    through.model.addHook('beforeBulkCreate', (rows) => {
      rows.push(through.model.build({ documentId: 4, projectId: 102 }));
    });
    await expect(mutate('add', [3], [101])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await linked()).toEqual([]);
    expect(await linked(4)).toEqual([]);
  });

  it.each(['beforeBulkCreate', 'afterBulkCreate'] as const)(
    'rejects a nested single through INSERT in %s',
    async (hook) => {
      through.model.addHook(hook, async (_rows, options) => {
        await through.model.create(
          { documentId: 4, projectId: 102 },
          { transaction: options.transaction, hooks: false },
        );
      });
      await expect(mutate('add', [3], [101])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(await linked()).toEqual([]);
      expect(await linked(4)).toEqual([]);
    },
  );

  it.each(['update', 'destroy'] as const)('rejects a nested through %s against another source', async (operation) => {
    await through.repository.create({ values: { documentId: 4, projectId: 102 } });
    through.model.addHook('afterBulkCreate', async (_rows, options) => {
      const write = { where: { documentId: 4 }, transaction: options.transaction, hooks: false };
      if (operation === 'update') await through.model.update({ projectId: 101 }, write);
      else await through.model.destroy(write);
    });
    await expect(mutate('add', [3], [101])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await linked()).toEqual([]);
    expect(await linked(4)).toEqual([102]);
    expect(db.sequelize.hasHook('beforeQuery')).toBe(false);
  });

  it('rejects a link deletion that would cascade into an independently writable record', async () => {
    through.setField('id', { type: 'integer', primaryKey: true, autoIncrement: true });
    await through.model.sync({ alter: true });
    await through.repository.create({ values: { documentId: 3, projectId: 101 } });
    const row = await through.model.findOne({ where: { documentId: 3 } });
    expect(row.getDataValue('id')).toBeTypeOf('number');
    const notes = db.collection({
      name: 'linkNotes',
      tableName: 'm2m_link_notes',
      timestamps: false,
      fields: [{ name: 'id', type: 'integer', primaryKey: true }],
    });
    notes.setField('link', {
      type: 'belongsTo',
      target: 'documentProjects',
      foreignKey: 'linkId',
      onDelete: 'SET NULL',
    });
    await notes.model.sync();
    await notes.repository.create({ values: { id: 1, linkId: row.getDataValue('id') } });
    expect((await notes.model.findByPk(1)).getDataValue('linkId')).toBe(row.getDataValue('id'));
    await expect(mutate('add', [3], [103])).resolves.toMatchObject({ affected: 1 });
    await expect(mutate('set', [3], [])).rejects.toMatchObject({ code: 'UNSUPPORTED_ACCESS_MUTATION' });
    expect(await linked()).toEqual([101, 103]);
    expect((await notes.model.findByPk(1)).getDataValue('linkId')).toBe(row.getDataValue('id'));
  });

  it('rejects a pure-schema join table with its own independently denying access rules', async () => {
    await store.save(
      throughIdentity,
      { ...configFor({ type: 'constant', value: false }), ownership: { enabled: false }, revision: 0 },
      { userId: 28 },
    );
    adapter.release(ctx);
    await adapter.prepare(ctx, [mainIdentity, target, throughIdentity]);
    await expect(mutate('add', [3], [101])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await linked()).toEqual([]);
  });

  it('rejects join keys simultaneously reused by unrelated business models', async () => {
    const hidden = db.collection({
      name: 'hiddenDocuments',
      tableName: 'm2m_hidden_documents',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'tenantId', type: 'string' },
      ],
    });
    await hidden.model.sync();
    await hidden.repository.create({ values: { id: 3, tenantId: 'C' } });
    hidden.model.belongsToMany(projects.model, {
      as: 'projects',
      through: through.model,
      foreignKey: 'documentId',
      otherKey: 'projectId',
      constraints: false,
    });
    await expect(mutate('add', [3], [101])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await linked()).toEqual([]);
  });

  it.each(['individualHooks', 'include', 'updateOnDuplicate', 'ignoreDuplicates'])(
    'rejects a hook enabling unsupported bulk option %s',
    async (field) => {
      through.model.addHook('beforeBulkCreate', (_rows, options) => {
        options[field] = field === 'include' ? [] : field === 'updateOnDuplicate' ? ['projectId'] : true;
      });
      await expect(mutate('add', [3], [101])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(await linked()).toEqual([]);
    },
  );

  it('rejects a bulk hook replacing the transaction before any out-of-transaction insert', async () => {
    through.model.addHook('beforeBulkCreate', (_rows, options) => {
      options.transaction = null;
    });
    await expect(mutate('add', [3], [101])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await linked()).toEqual([]);
  });

  it('rolls back an ownership change hidden in a through hook', async () => {
    through.model.addHook('afterBulkCreate', async (_rows, options) => {
      await docs.model.update({ tenantId: 'C' }, { where: { id: 3 }, transaction: options.transaction });
    });
    await expect(mutate('add', [3], [101])).rejects.toMatchObject({ code: 'ACCESS_OWNERSHIP_CHANGE_FORBIDDEN' });
    expect((await docs.model.findByPk(3)).getDataValue('tenantId')).toBe('B');
    expect(await linked()).toEqual([]);
  });

  it('rejects deletion hooks widening the where to other sources', async () => {
    await through.repository.create({
      values: [
        { documentId: 3, projectId: 101 },
        { documentId: 4, projectId: 102 },
      ],
    });
    through.model.addHook('beforeBulkDestroy', (options) => {
      options.where = {};
    });
    await expect(mutate('set', [3], [])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await linked()).toEqual([101]);
    expect(await linked(4)).toEqual([102]);
  });

  it('rolls back changes to another source foreign key hidden in a through hook', async () => {
    await db.sequelize.query('ALTER TABLE m2m_documents ADD COLUMN "otherProjectId" INTEGER');
    docs.setField('otherProject', { type: 'belongsTo', target: 'projects', foreignKey: 'otherProjectId' });
    through.model.addHook('afterBulkCreate', async (_rows, options) => {
      await docs.model.update({ otherProjectId: 102 }, { where: { id: 3 }, transaction: options.transaction });
    });
    await expect(mutate('add', [3], [101])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect((await docs.model.findByPk(3)).getDataValue('otherProjectId')).toBeNull();
    expect(await linked()).toEqual([]);
  });

  it('rolls back a legacy claim and connection deletion if insertion throws', async () => {
    await configure(configFor({ type: 'isNull', operand: { type: 'field', path: 'tenantId' } }));
    await through.repository.create({ values: { documentId: 5, projectId: 103 } });
    const original = new Error('original insert error');
    through.model.addHook('beforeBulkCreate', () => {
      throw original;
    });
    await expect(mutate('set', [5], [104])).rejects.toBe(original);
    expect(await linked(5)).toEqual([103]);
    expect((await docs.model.findByPk(5)).getDataValue('tenantId')).toBeNull();
  });

  it('rejects a phase ending after authorization but before the write', async () => {
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[1].collectionName === 'projects') adapter.release(ctx);
      return result;
    });
    await expect(mutate('add', [3], [101])).rejects.toThrow();
    expect(await linked()).toEqual([]);
  });

  it('rolls back if a through hook replaces the registered relation', async () => {
    through.model.addHook('afterBulkCreate', () => {
      delete docs.model.associations.projects;
    });
    await expect(mutate('add', [3], [101])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await linked()).toEqual([]);
  });

  it('does not invoke or retry writes when a concurrent target revokes visibility', async () => {
    const original = queries.scopeQuery.bind(queries);
    let changed = false;
    const inserts = vi.fn();
    through.model.addHook('beforeBulkCreate', inserts);
    vi.spyOn(queries, 'scopeQuery').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[1].collectionName === 'projects' && !changed) {
        changed = true;
        await projects.model.update({ name: 'Revoked' }, { where: { id: 101 } });
      }
      return result;
    });
    await expect(mutate('add', [3], [101])).rejects.toMatchObject({ code: 'ACCESS_MUTATION_CONFLICT', status: 409 });
    expect(inserts).not.toHaveBeenCalled();
    expect(await linked()).toEqual([]);
    expect((await projects.model.findByPk(101)).getDataValue('name')).toBe('Revoked');
  });

  it('rolls back relational visibility write skew without retrying or notifying', async () => {
    const readers = db.collection({
      name: 'readers',
      tableName: 'm2m_readers',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'projectId', type: 'integer' },
        { name: 'tenantId', type: 'string' },
        { name: 'canView', type: 'boolean' },
      ],
    });
    projects.setField('readers', { type: 'hasMany', target: 'readers', foreignKey: 'projectId' });
    await readers.model.sync();
    await readers.repository.create({ values: { id: 1, projectId: 101, tenantId: 'B', canView: true } });
    await store.save(
      target,
      {
        ...configFor(
          {
            type: 'exists',
            path: 'readers',
            condition: {
              type: 'all',
              children: [
                ownerCondition,
                {
                  type: 'compare',
                  operator: 'eq',
                  left: { type: 'field', path: 'canView' },
                  right: { type: 'literal', value: true },
                },
              ],
            },
          },
          'visibility',
        ),
        revision: (await store.read(target)).revision,
      },
      { userId: 28 },
    );
    adapter.release(ctx);
    await adapter.prepare(ctx, [mainIdentity, target, throughIdentity]);
    const notified = vi.fn();
    const writer = vi.fn(async (_rows, options) => {
      options.transaction.afterCommit(notified);
      await db.sequelize.transaction(
        { isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE },
        async (transaction) => {
          expect(await through.model.count({ where: { documentId: 3 }, transaction })).toBe(0);
          await readers.model.update({ canView: false }, { where: { id: 1 }, transaction });
        },
      );
    });
    through.model.addHook('beforeBulkCreate', writer);
    await expect(mutate('add', [3], [101])).rejects.toMatchObject({ code: 'ACCESS_MUTATION_CONFLICT', status: 409 });
    expect(writer).toHaveBeenCalledTimes(1);
    expect(notified).not.toHaveBeenCalled();
    expect(await linked()).toEqual([]);
    expect((await readers.model.findByPk(1)).getDataValue('canView')).toBe(false);
  });

  it('keeps canonical reverse relations usable', async () => {
    projects.setField('documents', {
      type: 'belongsToMany',
      target: 'documents',
      through: 'documentProjects',
      foreignKey: 'projectId',
      otherKey: 'documentId',
    });
    await mutate('add', [3], [101]);
    expect(await linked()).toEqual([101]);
  });

  it('sends a successful commit notification once and skips no-op writes', async () => {
    const notified = vi.fn();
    const writes = vi.fn((_rows, options) => {
      options.transaction.afterCommit(notified);
    });
    through.model.addHook('afterBulkCreate', writes);
    await mutate('add', [3], [101]);
    expect(notified).toHaveBeenCalledTimes(1);
    expect(await mutate('add', [3], [101])).toEqual({ keys: [], affected: 0 });
    expect(writes).toHaveBeenCalledTimes(1);
    expect(notified).toHaveBeenCalledTimes(1);
    expect(db.sequelize.hasHook('beforeBulkCreate')).toBe(false);
    expect(db.sequelize.hasHook('beforeBulkDestroy')).toBe(false);
  });
});

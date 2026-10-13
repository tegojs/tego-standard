import { ACL, literal, Transaction, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { AccessBelongsToService } from '../../access-control/belongs-to';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { AccessCreationService } from '../../access-control/creation';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessMutationService } from '../../access-control/mutation';
import { AccessQueryService } from '../../access-control/query';
import { AccessReferenceService } from '../../access-control/references';
import type { AccessConfig } from '../../access-control/types';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, seedDatabase, sqliteDatabase } from './database';
import { configFor, exampleConfig, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const target = { dataSourceKey: 'main', collectionKey: 'projects-key', collectionName: 'projects' };
const authenticated = { tenantId: 'B' };

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('access references (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let projects: Collection;
  let store: AccessConfigStore;
  let adapter: AccessAclScopeAdapter;
  let queries: AccessQueryService;
  let references: AccessReferenceService;
  let links: AccessBelongsToService;
  let ctx: object;
  const stableKey = (collection: Collection) =>
    accessCollectionKey({ ...mainIdentity, collectionKey: `${collection.name}-key`, collectionName: collection.name });

  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl) : sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    await seedDatabase(db);
    await db.sequelize.query('ALTER TABLE access_documents ADD COLUMN project_id INTEGER');
    docs = db.collection({
      name: 'documents',
      tableName: 'access_documents',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'tenantId', type: 'string', field: 'tenant_id' },
        { name: 'amount', type: 'integer' },
        { name: 'name', type: 'string' },
        { name: 'projectId', type: 'integer', field: 'project_id' },
      ],
    });
    db.collection({
      name: 'participants',
      tableName: 'access_participants',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'documentId', type: 'integer', field: 'document_id' },
        { name: 'businessTenant', type: 'string', field: 'business_tenant' },
        { name: 'canView', type: 'boolean', field: 'can_view' },
      ],
    });
    docs.setField('participants', { type: 'hasMany', target: 'participants', foreignKey: 'documentId' });
    projects = db.collection({
      name: 'projects',
      tableName: 'access_projects',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'tenantId', type: 'string' },
        { name: 'name', type: 'string' },
      ],
    });
    await projects.model.sync();
    docs.setField('project', { type: 'belongsTo', target: 'projects', foreignKey: 'projectId' });
    await projects.repository.create({
      values: [
        { id: 101, tenantId: 'H', name: 'Shared' },
        { id: 102, tenantId: 'C', name: 'Hidden' },
        { id: 103, tenantId: 'B', name: 'Owned' },
        { id: 104, tenantId: null, name: 'Legacy' },
      ],
    });
    await docs.model.update({ projectId: 101 }, { where: { id: 3 } });
    await docs.model.update({ projectId: 102 }, { where: { id: 1 } });
    const tenants = db.collection({
      name: 'tenants',
      tableName: 'verified_tenants',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'parentId', type: 'string' },
        { name: 'enabled', type: 'boolean' },
      ],
    });
    await tenants.model.sync();
    await tenants.repository.create({
      values: [
        { id: 'H', parentId: null, enabled: true },
        { id: 'B', parentId: 'H', enabled: true },
        { id: 'C', parentId: 'H', enabled: true },
      ],
    });
    await db.getRepository('collections').create({ values: { key: 'projects-key', name: 'projects' } });
    store = new AccessConfigStore(db, (identity) =>
      resolveModelMetadata(db.getCollection(identity.collectionName), { resolveCollectionKey: stableKey }),
    );
    await store.save(mainIdentity, { ...exampleConfig, revision: 0 }, { userId: 28 });
    await store.save(
      target,
      {
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
            id: 'shared-reference',
          },
        ],
      },
      { userId: 28 },
    );
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    queries = new AccessQueryService(db, adapter, stableKey);
    references = new AccessReferenceService(db, adapter, queries);
    links = new AccessBelongsToService(
      db,
      adapter,
      queries,
      new AccessMutationService(db, adapter, queries),
      references,
    );
    ctx = {};
    await adapter.prepare(ctx, [mainIdentity, target]);
  });

  afterEach(async () => {
    try {
      if (dialect === 'postgres')
        await db.sequelize.query(
          'DROP TABLE IF EXISTS "rolesResourcesScopesActions", "dataSourcesRolesResourcesScopesActions", ' +
            '"rolesResourcesScopes", "dataSourcesRolesResourcesScopes", ' +
            '"access_config_collections", "access_config_dataSourcesCollections", "tenantAccessRevisions", ' +
            '"access_documents", "access_projects", "access_participants", "access_links", "access_tenants", "verified_tenants"',
        );
    } finally {
      await db.close();
    }
  });

  async function configure(config: AccessConfig) {
    await store.save(mainIdentity, { ...config, revision: (await store.read(mainIdentity)).revision }, { userId: 28 });
    adapter.release(ctx);
    await adapter.prepare(ctx, [mainIdentity, target]);
  }

  async function targetIds(sourceKey: string | number, extra = {}) {
    const plan = await references.scopeBelongsToTarget(ctx, mainIdentity, target, authenticated, {
      association: 'project',
      sourceKey,
      ...extra,
    });
    const rows = await projects.model.findAll(plan.query);
    return rows.map((row) => row.getDataValue('id'));
  }

  async function set(sourceKeys: Array<string | number>, targetKey: number | null, extra = {}, writer?) {
    return links.withReference(
      ctx,
      mainIdentity,
      target,
      authenticated,
      { association: 'project', sourceKeys, targetKey, ...extra },
      writer ??
        (async (plan) => {
          for (const record of plan.records)
            await docs.repository.update({
              filterByTk: record.getDataValue('id'),
              values: plan.valuesFor(record),
              transaction: plan.transaction,
            });
        }),
    );
  }

  it('allows owned and visibility-only targets without claiming a legacy target', async () => {
    const rows = await references.authorizeTargets(ctx, target, authenticated, { keys: [101, 103, 104] });
    expect(rows.map((row) => row.getDataValue('id'))).toEqual([101, 103, 104]);
    expect((await projects.model.findByPk(104)).getDataValue('tenantId')).toBeNull();
  });

  it('rejects a whole explicit target batch when one is hidden or missing', async () => {
    for (const keys of [
      [101, 102],
      [103, 999],
    ])
      await expect(references.authorizeTargets(ctx, target, authenticated, { keys })).rejects.toMatchObject({
        code: 'ACCESS_RECORD_UNAVAILABLE',
      });
  });

  it('intersects target role predicates and preserves named bindings', async () => {
    await expect(
      references.authorizeTargets(ctx, target, authenticated, {
        keys: [101],
        where: { name: 'Owned' },
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(
      await targetIds(3, {
        targetWhere: literal('"projects"."name" = $tac_scope0_name'),
        targetBind: { tac_scope0_name: 'Shared' },
      }),
    ).toEqual([101]);
  });

  it('checks source readability independently of target readability', async () => {
    expect(await targetIds(3)).toEqual([101]);
    expect(await targetIds(1)).toEqual([]);
    await expect(targetIds(2)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    await expect(targetIds(3, { sourceWhere: { amount: 0 } })).rejects.toMatchObject({
      code: 'ACCESS_RECORD_UNAVAILABLE',
    });
  });

  it('returns an empty target scope for an empty foreign key', async () => {
    await docs.model.update({ projectId: null }, { where: { id: 3 } });
    expect(await targetIds(3)).toEqual([]);
  });

  it('keeps target restrictions for the core underscore protocol', async () => {
    expect(await targetIds('_', { targetKey: 101 })).toEqual([101]);
    expect(await targetIds('_', { targetKey: 102 })).toEqual([]);
    await expect(targetIds('_')).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });

  it('uses the stored foreign key rather than a display getter', async () => {
    docs.model.rawAttributes.projectId.get = () => 103;
    docs.model.refreshAttributes();
    expect(await targetIds(3)).toEqual([101]);
  });

  it('applies association scopes even for direct underscore target reads', async () => {
    const association = docs.model.associations.project as typeof docs.model.associations.project & { scope: object };
    association.scope = { name: 'Owned' };
    expect(await targetIds(3)).toEqual([]);
    expect(await targetIds('_', { targetKey: 101 })).toEqual([]);
    expect(await targetIds('_', { targetKey: 103 })).toEqual([103]);
  });

  it('does not let an explicit target key override the stored source foreign key', async () => {
    expect(await targetIds(3, { targetKey: 103 })).toEqual([]);
  });

  it('respects target default model scopes', async () => {
    projects.model.addScope('defaultScope', { where: { name: 'Owned' } }, { override: true });
    expect(await targetIds('_', { targetKey: 101 })).toEqual([]);
    await expect(references.authorizeTargets(ctx, target, authenticated, { keys: [101] })).rejects.toMatchObject({
      code: 'ACCESS_RECORD_UNAVAILABLE',
    });
  });

  it('requires an active tenant when referenced visibility uses tenant context', async () => {
    await expect(references.authorizeTargets(ctx, target, {}, { keys: [101] })).rejects.toThrow();
  });

  it('does not publish a delayed reference authorization after its phase ends', async () => {
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementation(async (...args) => {
      const result = await original(...args);
      adapter.release(ctx);
      return result;
    });
    await expect(references.authorizeTargets(ctx, target, authenticated, { keys: [101] })).rejects.toThrow();
  });

  it('rejects non-primary association target keys', async () => {
    const association = docs.model.associations.project as typeof docs.model.associations.project & {
      targetKey: string;
    };
    association.targetKey = 'name';
    await expect(targetIds(3)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });

  it('rejects positional SQL bindings and invalid explicit keys', async () => {
    await expect(
      references.authorizeTargets(ctx, target, authenticated, { keys: [101], bind: [] as never }),
    ).rejects.toThrow('named');
    await expect(references.authorizeTargets(ctx, target, authenticated, { keys: ['_'] })).rejects.toMatchObject({
      code: 'INVALID_ACCESS_MUTATION',
    });
  });

  it('rejects unprepared phases and same-named collections in another data source', async () => {
    await expect(references.authorizeTargets({}, target, authenticated, { keys: [101] })).rejects.toThrow();
    await expect(
      references.scopeBelongsToTarget(ctx, mainIdentity, { ...target, dataSourceKey: 'external' }, authenticated, {
        association: 'project',
        sourceKey: 3,
      }),
    ).rejects.toThrow();
  });

  it('does not allow a non-BelongsTo relation or the wrong target identity', async () => {
    await expect(targetIds(3, { association: 'participants' })).rejects.toThrow();
    await expect(
      references.scopeBelongsToTarget(ctx, mainIdentity, mainIdentity, authenticated, {
        association: 'project',
        sourceKey: 3,
      }),
    ).rejects.toThrow();
  });

  it.each(['root', 'create'])(
    'allows managed ownership stored as an actual tenant foreign key during %s',
    async (kind) => {
      docs.setField('tenant', { type: 'belongsTo', target: 'tenants', foreignKey: 'tenantId' });
      await configure(
        configFor({
          type: 'any',
          children: [ownerCondition, { type: 'isNull', operand: { type: 'field', path: 'tenantId' } }],
        }),
      );
      if (kind === 'root') {
        await new AccessMutationService(db, adapter, queries).withExistingRecords(
          ctx,
          mainIdentity,
          authenticated,
          { operation: 'update', keys: [5], values: { name: 'claimed', tenantId: null } },
          async (plan) => {
            await docs.repository.update({
              filterByTk: 5,
              values: plan.valuesFor(plan.records[0]),
              transaction: plan.transaction,
            });
          },
        );
        expect((await docs.model.findByPk(5)).get()).toMatchObject({ tenantId: 'B', name: 'claimed' });
      } else {
        await new AccessCreationService(db, adapter, queries).withCreatedRecords(
          ctx,
          mainIdentity,
          authenticated,
          {
            values: [
              { id: 100, amount: 1 },
              { id: 101, amount: 2, tenantId: null },
            ],
          },
          async (plan) => {
            const records = [];
            for (const values of plan.values)
              records.push(await docs.repository.create({ values, transaction: plan.transaction }));
            return records;
          },
        );
        expect((await docs.model.findByPk(100)).getDataValue('tenantId')).toBe('B');
        expect((await docs.model.findByPk(101)).getDataValue('tenantId')).toBe('B');
      }
    },
  );

  if (dialect === 'sqlite') {
    it('explicitly refuses relationship writes on an unvalidated write dialect', async () => {
      await expect(set([3], 103)).rejects.toMatchObject({ code: 'UNSUPPORTED_ACCESS_MUTATION' });
    });
    return;
  }

  it('updates only the source foreign key and preserves ownership on both sides', async () => {
    expect(await set([3], 104)).toEqual({ keys: [3], affected: 1 });
    expect((await docs.model.findByPk(3)).get()).toMatchObject({ tenantId: 'B', projectId: 104 });
    expect((await projects.model.findByPk(104)).getDataValue('tenantId')).toBeNull();
  });

  it('refuses a visibility-only source before invoking the writer', async () => {
    const writer = vi.fn();
    await expect(set([1], 101, {}, writer)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(writer).not.toHaveBeenCalled();
  });

  it('claims a writable historical source without claiming its historical target', async () => {
    await configure(
      configFor({
        type: 'any',
        children: [ownerCondition, { type: 'isNull', operand: { type: 'field', path: 'tenantId' } }],
      }),
    );
    expect(await set([5], 104)).toEqual({ keys: [5], affected: 1 });
    expect((await docs.model.findByPk(5)).get()).toMatchObject({ tenantId: 'B', projectId: 104 });
    expect((await projects.model.findByPk(104)).getDataValue('tenantId')).toBeNull();
  });

  it('allows a legacy claim whose managed ownership field is also a tenant relation', async () => {
    docs.setField('tenant', { type: 'belongsTo', target: 'tenants', foreignKey: 'tenantId' });
    await configure(configFor({ type: 'isNull', operand: { type: 'field', path: 'tenantId' } }));
    expect(await set([5], 104)).toEqual({ keys: [5], affected: 1 });
    expect((await docs.model.findByPk(5)).getDataValue('tenantId')).toBe('B');
  });

  it('can clear a source foreign key without reading an old hidden target', async () => {
    await docs.model.update({ projectId: 102 }, { where: { id: 3 } });
    expect(await set([3], null)).toEqual({ keys: [3], affected: 1 });
    expect((await docs.model.findByPk(3)).getDataValue('projectId')).toBeNull();
  });

  it('rolls back an unauthorized explicit source or target batch', async () => {
    await expect(set([3, 1], 101)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    await expect(set([3], 102)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect((await docs.model.findByPk(3)).getDataValue('projectId')).toBe(101);
  });

  it('preserves source and target role conditions on relation writes', async () => {
    await expect(set([3], 103, { sourceWhere: { amount: 0 } })).rejects.toThrow();
    await expect(set([3], 101, { targetWhere: { name: 'Owned' } })).rejects.toThrow();
  });

  it('does not relax ordinary update validation for relationship fields or empty patches', async () => {
    const mutations = new AccessMutationService(db, adapter, queries);
    for (const values of [{ projectId: 103 }, {}])
      await expect(
        mutations.withExistingRecords(
          ctx,
          mainIdentity,
          authenticated,
          { operation: 'update', keys: [3], values },
          vi.fn(),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });

  it('refuses a relation whose foreign key also changes a different association', async () => {
    docs.setField('otherProject', { type: 'belongsTo', target: 'projects', foreignKey: 'projectId' });
    await expect(set([3], 103)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });

  it('rolls back a callback error unchanged, including null', async () => {
    for (const error of [new Error('original writer failure'), null]) {
      await expect(
        set([3], 103, {}, async (plan) => {
          await docs.model.update(plan.valuesFor(plan.records[0]), { where: { id: 3 }, transaction: plan.transaction });
          throw error;
        }),
      ).rejects.toBe(error);
      expect((await docs.model.findByPk(3)).getDataValue('projectId')).toBe(101);
    }
  });

  it('rejects a writer that omits the requested foreign-key change', async () => {
    await expect(set([3], 103, {}, async () => {})).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });

  it('rejects historical source writes matched only by visibility', async () => {
    await configure(configFor({ type: 'isNull', operand: { type: 'field', path: 'tenantId' } }, 'visibility'));
    await expect(set([5], 104)).rejects.toMatchObject({ code: 'LEGACY_DATA_READ_ONLY' });
    expect((await docs.model.findByPk(5)).getDataValue('tenantId')).toBeNull();
  });

  it('rolls back an incorrect foreign key written by a hook', async () => {
    docs.model.addHook('beforeUpdate', (record) => record.setDataValue('projectId', 102));
    await expect(set([3], 103)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect((await docs.model.findByPk(3)).getDataValue('projectId')).toBe(101);
  });

  it.each(['reference', 'root'])('rolls back a hook changing another association during a %s edit', async (kind) => {
    await db.sequelize.query('ALTER TABLE access_documents ADD COLUMN other_project_id INTEGER');
    docs.setField('otherProjectId', { type: 'integer', field: 'other_project_id' });
    docs.setField('otherProject', { type: 'belongsTo', target: 'projects', foreignKey: 'otherProjectId' });
    await docs.model.update({ otherProjectId: 103 }, { where: { id: 3 } });
    docs.model.addHook('beforeUpdate', (record) => record.setDataValue('otherProjectId', 102));
    const notified = vi.fn();
    const writer = async (plan) => {
      plan.transaction.afterCommit(notified);
      await docs.repository.update({
        filterByTk: 3,
        values: plan.valuesFor(plan.records[0]),
        transaction: plan.transaction,
      });
    };
    const operation =
      kind === 'reference'
        ? set([3], 103, {}, writer)
        : new AccessMutationService(db, adapter, queries).withExistingRecords(
            ctx,
            mainIdentity,
            authenticated,
            { operation: 'update', keys: [3], values: { name: 'edited' } },
            writer,
          );
    await expect(operation).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(notified).not.toHaveBeenCalled();
    expect((await docs.model.findByPk(3)).get()).toMatchObject({ projectId: 101, otherProjectId: 103, name: 'D3' });
  });

  it('rolls back a forged source owner and sends no afterCommit notification', async () => {
    const notified = vi.fn();
    await expect(
      set([3], 103, {}, async (plan) => {
        plan.transaction.afterCommit(notified);
        await docs.model.update({ projectId: 103, tenantId: 'C' }, { where: { id: 3 }, transaction: plan.transaction });
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_OWNERSHIP_CHANGE_FORBIDDEN' });
    expect(notified).not.toHaveBeenCalled();
    expect((await docs.model.findByPk(3)).get()).toMatchObject({ tenantId: 'B', projectId: 101 });
  });

  it('allows a legal reference change to leave its old ownership rule', async () => {
    await configure(
      configFor({
        type: 'exists',
        path: 'project',
        condition: {
          type: 'compare',
          operator: 'eq',
          left: { type: 'field', path: 'name' },
          right: { type: 'literal', value: 'Shared' },
        },
      }),
    );
    expect(await set([3], 103)).toEqual({ keys: [3], affected: 1 });
    expect((await docs.model.findByPk(3)).getDataValue('projectId')).toBe(103);
  });

  it('rolls back if the relation is replaced during a write', async () => {
    const old = docs.model.associations.project;
    try {
      await expect(
        set([3], 103, {}, async (plan) => {
          await docs.model.update(plan.valuesFor(plan.records[0]), { where: { id: 3 }, transaction: plan.transaction });
          docs.model.associations.project = Object.create(old);
        }),
      ).rejects.toThrow();
    } finally {
      docs.model.associations.project = old;
    }
    expect((await docs.model.findByPk(3)).getDataValue('projectId')).toBe(101);
  });

  it('uses real serializable isolation for both source and target authorization', async () => {
    await set([3], 103, {}, async (plan) => {
      const [rows] = await db.sequelize.query("SELECT current_setting('transaction_isolation') AS isolation", {
        transaction: plan.transaction,
      });
      expect(rows[0].isolation).toBe('serializable');
      await docs.model.update(plan.valuesFor(plan.records[0]), { where: { id: 3 }, transaction: plan.transaction });
    });
  });

  it('rejects a concurrently changed target without invoking or retrying the writer', async () => {
    const original = queries.scopeQuery.bind(queries);
    let changed = false;
    vi.spyOn(queries, 'scopeQuery').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[1].collectionName === 'projects' && !changed) {
        changed = true;
        await db.sequelize.transaction(async (transaction) => {
          await projects.model.update({ name: 'Revoked' }, { where: { id: 101 }, transaction });
        });
      }
      return result;
    });
    const writer = vi.fn();
    await expect(set([3], 101, {}, writer)).rejects.toMatchObject({ code: 'ACCESS_MUTATION_CONFLICT', status: 409 });
    expect(writer).not.toHaveBeenCalled();
    expect((await projects.model.findByPk(101)).getDataValue('name')).toBe('Revoked');
  });

  it('rolls back a relational visibility write skew without rerunning or notifying', async () => {
    projects.setField('participants', { type: 'hasMany', target: 'participants', foreignKey: 'documentId' });
    await db.getCollection('participants').repository.create({
      values: {
        id: 20,
        documentId: 101,
        businessTenant: 'B',
        canView: true,
      },
    });
    await store.save(target, { ...exampleConfig, revision: (await store.read(target)).revision }, { userId: 28 });
    adapter.release(ctx);
    await adapter.prepare(ctx, [mainIdentity, target]);
    await docs.model.update({ projectId: 103 }, { where: { id: 3 } });
    const notified = vi.fn();
    const writer = vi.fn(async (plan) => {
      plan.transaction.afterCommit(notified);
      await db.sequelize.transaction(
        { isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE },
        async (transaction) => {
          expect((await docs.model.findByPk(3, { transaction })).getDataValue('projectId')).toBe(103);
          await db.getCollection('participants').model.update({ canView: false }, { where: { id: 20 }, transaction });
        },
      );
      await docs.model.update(plan.valuesFor(plan.records[0]), { where: { id: 3 }, transaction: plan.transaction });
    });
    await expect(set([3], 101, {}, writer)).rejects.toMatchObject({ code: 'ACCESS_MUTATION_CONFLICT', status: 409 });
    expect(writer).toHaveBeenCalledTimes(1);
    expect(notified).not.toHaveBeenCalled();
    expect((await docs.model.findByPk(3)).getDataValue('projectId')).toBe(103);
    expect((await db.getCollection('participants').model.findByPk(20)).getDataValue('canView')).toBe(false);
  });
});

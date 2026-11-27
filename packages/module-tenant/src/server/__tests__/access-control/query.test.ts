import { ACL, literal, Op, type Collection, type Database, type Transaction } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey } from '../../access-control/config-store';
import { AccessQueryService } from '../../access-control/query';
import { seedAclScopes } from './acl-database';
import { configStore, mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, queryRows, seedDatabase, sqliteDatabase } from './database';
import { configFor, exampleConfig } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('tenant access root query service (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let adapter: AccessAclScopeAdapter;
  let service: AccessQueryService;
  let store: ReturnType<typeof configStore>;
  let ctx: object;
  const stableKey = (collection: Collection) =>
    accessCollectionKey({ ...mainIdentity, collectionKey: `${collection.name}-key`, collectionName: collection.name });

  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl) : sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    await seedDatabase(db);
    docs = db.collection({
      name: 'documents',
      tableName: 'access_documents',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'tenantId', type: 'string', field: 'tenant_id' },
        { name: 'amount', type: 'integer' },
        { name: 'name', type: 'string' },
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
    store = configStore(db);
    await store.save(mainIdentity, { ...exampleConfig, revision: 0 }, { userId: 28 });
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    service = new AccessQueryService(db, adapter, stableKey);
    ctx = {};
    await adapter.prepare(ctx, [mainIdentity]);
  });

  afterEach(async () => {
    try {
      if (dialect === 'postgres') {
        await db.sequelize.query(
          'DROP TABLE IF EXISTS "rolesResourcesScopesActions", "dataSourcesRolesResourcesScopesActions", ' +
            '"rolesResourcesScopes", "dataSourcesRolesResourcesScopes", ' +
            '"access_config_collections", "access_config_dataSourcesCollections", "tenantAccessRevisions", ' +
            '"access_documents", "access_participants", "access_links", "access_tenants", "verified_tenants"',
        );
      }
    } finally {
      await db.close();
    }
  });

  async function plan(tenantId = 'B', kind: 'read' | 'ownership' = 'read', options = {}) {
    return service.scopeQuery(ctx, mainIdentity, { tenantId }, options, kind);
  }

  async function ids(tenantId = 'B', kind: 'read' | 'ownership' = 'read', options = {}) {
    const scoped = await plan(tenantId, kind, options);
    const rows = await docs.model.findAll({ ...scoped.query, attributes: ['id'], order: [['id', 'ASC']] });
    return rows.map((row) => row.get('id'));
  }

  describe('native scope resolution', () => {
    async function nativeIds(kind: 'read' | 'ownership' | 'visibility', transaction?: Transaction) {
      const resolved = await service.resolveNativeScopes(ctx, mainIdentity, { tenantId: 'B' }, { transaction });
      const rows = await queryRows<{ id: number }>(
        db,
        `SELECT id FROM access_documents AS documents WHERE ${resolved.scopes[kind].sql} ORDER BY id`,
        { transaction },
      );
      return rows.map((row) => row.id);
    }

    it('uses verified context and registered association metadata for native G and V', async () => {
      expect(await nativeIds('ownership')).toEqual([3]);
      expect(await nativeIds('visibility')).toEqual([1]);
      expect(await nativeIds('read')).toEqual([1, 3]);
      await db.sequelize.query('UPDATE access_participants SET can_view=false WHERE document_id=1');
      expect(await nativeIds('read')).toEqual([3]);
    });

    it('uses only the server dialect encoder, with no bindings even for dollar aliases', async () => {
      const untrustedOptions = { rootAlias: '$tac_0', quoteValue: () => "'B' OR TRUE", native: true };
      const resolved = await service.resolveNativeScopes(ctx, mainIdentity, { tenantId: 'B' }, untrustedOptions);
      expect(resolved.scopes.read.bind).toEqual({});
      const rows = await queryRows<{ id: number }>(
        db,
        `SELECT id FROM access_documents AS "$tac_0" WHERE ${resolved.scopes.read.sql} ORDER BY id`,
      );
      expect(rows.map((row) => row.id)).toEqual([1, 3]);
      expect(
        (await plan('B', 'read', { quoteValue: untrustedOptions.quoteValue, native: true })).query.bind,
      ).not.toEqual({});
      expect(await ids('B', 'read', { quoteValue: untrustedOptions.quoteValue, native: true })).toEqual([1, 3]);
    });

    it('preserves quoted physical identifiers instead of silently selecting another column', async () => {
      await db.sequelize.query('ALTER TABLE access_documents RENAME COLUMN tenant_id TO "tenant""id"');
      await db.sequelize.query('ALTER TABLE access_participants RENAME COLUMN business_tenant TO "business""tenant"');
      docs.model.rawAttributes.tenantId.field = 'tenant"id';
      db.getCollection('participants').model.rawAttributes.businessTenant.field = 'business"tenant';
      const resolved = await service.resolveNativeScopes(
        ctx,
        mainIdentity,
        { tenantId: 'B' },
        { rootAlias: 'native"root' },
      );
      const rows = await queryRows<{ id: number }>(
        db,
        `SELECT id FROM access_documents AS "native""root" WHERE ${resolved.scopes.read.sql} ORDER BY id`,
      );
      expect(rows.map((row) => row.id)).toEqual([1, 3]);
    });

    it('rejects dialects without an explicit native identifier contract', async () => {
      const dialectMethod = vi.spyOn(db.sequelize, 'getDialect').mockReturnValue('mysql');
      try {
        await expect(service.resolveNativeScopes(ctx, mainIdentity, { tenantId: 'B' })).rejects.toThrow('dialect');
      } finally {
        dialectMethod.mockRestore();
      }
    });

    it('rejects missing and disabled tenant identities', async () => {
      await expect(service.resolveNativeScopes(ctx, mainIdentity, {})).rejects.toThrow();
      await db.getCollection('tenants').model.update({ enabled: false }, { where: { id: 'B' } });
      await expect(service.resolveNativeScopes(ctx, mainIdentity, { tenantId: 'B' })).rejects.toThrow('disabled');
    });

    it('rejects ended and foreign transactions and reads facts in the actual transaction', async () => {
      let finished: Transaction;
      await db.sequelize.transaction(async (transaction) => {
        finished = transaction;
        await db.sequelize.query('UPDATE access_participants SET can_view=false', { transaction });
        expect(await nativeIds('read', transaction)).toEqual([3]);
      });
      await expect(
        service.resolveNativeScopes(ctx, mainIdentity, { tenantId: 'B' }, { transaction: finished }),
      ).rejects.toThrow('transaction');
      const other = sqliteDatabase();
      try {
        await other.sequelize.transaction(async (transaction) => {
          await expect(
            service.resolveNativeScopes(ctx, mainIdentity, { tenantId: 'B' }, { transaction }),
          ).rejects.toThrow('transaction');
        });
      } finally {
        await other.close();
      }
    });

    it('rejects a transaction that finishes during context lookup', async () => {
      const transaction = await db.sequelize.transaction();
      const tenants = db.getCollection('tenants').model;
      const findOne = tenants.findOne.bind(tenants);
      vi.spyOn(tenants, 'findOne').mockImplementationOnce(async (query) => {
        const row = await findOne(query);
        await transaction.commit();
        return row;
      });
      try {
        await expect(
          service.resolveNativeScopes(ctx, mainIdentity, { tenantId: 'B' }, { transaction }),
        ).rejects.toThrow('transaction');
      } finally {
        if (!(transaction as Transaction & { finished?: string }).finished) await transaction.rollback();
      }
    });

    it.each(['phase', 'collection', 'association', 'association identity'])(
      'rejects %s drift while resolving context',
      async (change) => {
        const tenants = db.getCollection('tenants').model;
        const findOne = tenants.findOne.bind(tenants);
        vi.spyOn(tenants, 'findOne').mockImplementationOnce(async (options) => {
          const row = await findOne(options);
          if (change === 'phase') {
            adapter.release(ctx);
            await adapter.prepare(ctx, [mainIdentity]);
          } else if (change === 'collection') {
            db.removeCollection('documents');
            db.collection({ name: 'documents', timestamps: false, fields: [{ name: 'tenantId', type: 'string' }] });
          } else if (change === 'association identity') {
            db.getCollection('participants').options.key = 'replacement-participants-key';
          } else {
            db.getCollection('participants').model.rawAttributes.canView.field = 'changed_column';
          }
          return row;
        });
        await expect(service.resolveNativeScopes(ctx, mainIdentity, { tenantId: 'B' })).rejects.toThrow(
          /phase|identity|metadata/,
        );
      },
    );

    it('captures caller identity and alias before the context lookup awaits', async () => {
      const actor = { tenantId: 'B' };
      const options = { rootAlias: '$tac_0' };
      const tenants = db.getCollection('tenants').model;
      const findOne = tenants.findOne.bind(tenants);
      vi.spyOn(tenants, 'findOne').mockImplementationOnce(async (query) => {
        actor.tenantId = 'C';
        options.rootAlias = 'changed_alias';
        return findOne(query);
      });
      const resolved = await service.resolveNativeScopes(ctx, mainIdentity, actor, options);
      const rows = await queryRows<{ id: number }>(
        db,
        `SELECT id FROM access_documents AS "$tac_0" WHERE ${resolved.scopes.read.sql} ORDER BY id`,
      );
      expect(rows.map((row) => row.id)).toEqual([1, 3]);
    });

    it('requires an actual prepared identity and keeps missing configuration explicit', async () => {
      await expect(service.resolveNativeScopes({}, mainIdentity, { tenantId: 'B' })).rejects.toThrow('identity');
      await expect(
        service.resolveNativeScopes(ctx, { ...mainIdentity, collectionKey: 'other' }, { tenantId: 'B' }),
      ).rejects.toThrow('identity');
      const record = await db.getRepository('collections').findOne({ filter: { key: mainIdentity.collectionKey } });
      await record.update({ options: {} });
      adapter.release(ctx);
      await adapter.prepare(ctx, [mainIdentity]);
      expect(await service.resolveNativeScopes(ctx, mainIdentity, {})).toBeNull();
    });
  });

  describe('unconditional ownership proof', () => {
    async function prepare(
      config = { ...configFor({ type: 'constant', value: true }), ownership: { enabled: false } },
    ) {
      const previous = (await store.read(mainIdentity))!;
      await store.save(mainIdentity, { ...config, revision: previous.revision }, { userId: 28 });
      adapter.release(ctx);
      ctx = {};
      await adapter.prepare(ctx, [mainIdentity]);
    }

    it.each([
      'shared',
      'logical',
      'disabled-context',
      'conditional',
      'visibility-only',
      'managed',
      'identity',
      'empty',
    ])('checks the actual G of %s rules without executing SQL', async (kind) => {
      const config = { ...configFor({ type: 'constant', value: true }), ownership: { enabled: false } };
      if (kind === 'logical')
        config.rules[0].condition = {
          type: 'any',
          children: [
            { type: 'constant', value: false },
            { type: 'constant', value: true },
          ],
        };
      if (kind === 'disabled-context')
        config.rules.push({
          ...configFor({ type: 'constant', value: true }).rules[0],
          id: 'off',
          enabled: false,
          subject: {
            type: 'compare',
            operator: 'eq',
            left: { type: 'context', path: 'user.id' },
            right: { type: 'literal', value: '28' },
          },
        });
      if (kind === 'conditional')
        config.rules[0].condition = {
          type: 'compare',
          operator: 'eq',
          left: { type: 'field', path: 'id' },
          right: { type: 'literal', value: 1 },
        };
      if (kind === 'visibility-only') config.rules[0].category = 'visibility';
      if (kind === 'managed') config.ownership.enabled = true;
      if (kind === 'identity')
        config.rules[0].subject = {
          type: 'compare',
          operator: 'eq',
          left: { type: 'context', path: 'user.id' },
          right: { type: 'literal', value: '28' },
        };
      if (kind === 'empty') config.rules = [];
      await prepare(config);
      const sql = vi.spyOn(db.sequelize, 'query');
      try {
        expect(service.hasUnconditionalOwnership(ctx, mainIdentity)).toBe(
          ['shared', 'logical', 'disabled-context'].includes(kind),
        );
        expect(sql).not.toHaveBeenCalled();
      } finally {
        sql.mockRestore();
      }
    });

    it('does not treat tenant-scoped collections as unconditionally owned', async () => {
      await prepare();
      docs.options.tenancy = 'tenantScoped';

      expect(service.hasUnconditionalOwnership(ctx, mainIdentity)).toBe(false);
    });
    it('includes the effective model scope in the proof', async () => {
      await prepare();
      docs.model.addScope('defaultScope', { where: { amount: { [Op.gt]: 100 } } }, { override: true });
      expect(service.hasUnconditionalOwnership(ctx, mainIdentity)).toBe(false);
    });

    it('rejects stale phases and wrong stable keys rather than treating them as unrestricted', async () => {
      await prepare();
      expect(() => service.hasUnconditionalOwnership(ctx, { ...mainIdentity, collectionKey: 'other' })).toThrow();
      adapter.release(ctx);
      expect(() => service.hasUnconditionalOwnership(ctx, mainIdentity)).toThrow();
    });
  });

  it('reserves future binding names without adding unused values to root aggregates', async () => {
    const scoped = await plan('B', 'read', { reservedBindNames: ['tac_scope0_0'] });
    expect(scoped.query.bind).not.toHaveProperty('tac_scope0_0');
    expect(await docs.model.count(scoped.query)).toBe(2);
    expect(await docs.model.sum('amount', scoped.query)).toBe(400);
  });

  it.each([
    ['H', [1, 2, 6], 900],
    ['B', [1, 3], 400],
    ['C', [4, 6], 1000],
  ])(
    'uses the same scope for %s list, count and root sum without duplicating matches',
    async (tenant, expected, total) => {
      const scoped = await plan(tenant as string);
      expect(await ids(tenant as string)).toEqual(expected);
      expect(await docs.model.count(scoped.query)).toBe((expected as number[]).length);
      expect(await docs.model.sum('amount', scoped.query)).toBe(total);
    },
  );

  it('uses only ownership for pre-mutation selection', async () => {
    expect(await ids('B', 'ownership')).toEqual([3]);
    expect(await ids('C', 'ownership')).toEqual([4]);
    expect(await ids('H', 'ownership')).toEqual([1, 2, 6]);
  });

  it('intersects all existing ACL and request conditions without modifying caller objects', async () => {
    const where = { [Op.and]: [{ amount: { [Op.gte]: 200 } }, { name: { [Op.ne]: 'D4' } }] };
    expect(await ids('B', 'read', { where })).toEqual([3]);
    expect(where).toEqual({ [Op.and]: [{ amount: { [Op.gte]: 200 } }, { name: { [Op.ne]: 'D4' } }] });
    expect(await ids('B', 'read', { where: { tenantId: 'H' } })).toEqual([1]);
  });

  it('preserves named SQL bindings and chooses a non-conflicting namespace', async () => {
    const bind = { tac_scope0_0: 200, tac_scope1_unused: 'sentinel' };
    const where = literal('"documents"."amount" >= $tac_scope0_0 AND $tac_scope1_unused = \'sentinel\'');
    const scoped = await plan('B', 'read', { where, bind });
    expect(scoped.query.bind).toMatchObject(bind);
    expect(Object.keys(scoped.query.bind)).toContain('tac_scope2_0');
    expect(bind).toEqual({ tac_scope0_0: 200, tac_scope1_unused: 'sentinel' });
    expect(await ids('B', 'read', { where, bind })).toEqual([3]);
  });

  it('uses the supplied root alias with actual physical table and column names', async () => {
    const scoped = await service.resolveScopes(ctx, mainIdentity, { tenantId: 'B' }, { rootAlias: 'custom_root' });
    const rows = await queryRows<{ id: number }>(
      db,
      `SELECT id FROM access_documents AS custom_root WHERE ${scoped.scopes.read.sql} ORDER BY id`,
      { bind: scoped.scopes.read.bind },
    );
    expect(rows.map((row) => row.id)).toEqual([1, 3]);
  });

  it('keeps its prepared revision while a new phase sees newly saved rules', async () => {
    await store.save(mainIdentity, { ...exampleConfig, revision: 1, rules: [] }, { userId: 28 });
    expect((await plan()).config.revision).toBe(1);
    expect(await ids()).toEqual([1, 3]);
    adapter.release(ctx);
    await adapter.prepare(ctx, [mainIdentity]);
    expect((await plan()).config.revision).toBe(2);
    expect(await ids()).toEqual([]);
  });

  it('does not accept an unprepared, released, or recreated collection identity', async () => {
    await expect(service.scopeQuery({}, mainIdentity, { tenantId: 'B' })).rejects.toThrow('identity');
    await expect(
      service.scopeQuery(ctx, { ...mainIdentity, collectionKey: 'recreated' }, { tenantId: 'B' }),
    ).rejects.toThrow('identity');
    adapter.release(ctx);
    await expect(plan()).rejects.toThrow('identity');
  });

  it('rejects a runtime model with a mismatched stable identity', async () => {
    const incorrect = new AccessQueryService(db, adapter, () => 'main:wrong-table');
    await expect(incorrect.scopeQuery(ctx, mainIdentity, { tenantId: 'B' })).rejects.toThrow('identity');
  });

  it('requires the verified active tenant needed by the rules', async () => {
    await expect(service.scopeQuery(ctx, mainIdentity, {})).rejects.toThrow();
    await db.getCollection('tenants').model.update({ enabled: false }, { where: { id: 'B' } });
    await expect(plan()).rejects.toThrow(/disabled/);
  });

  it('allows an explicitly shared rule without a tenant lookup', async () => {
    await store.save(
      mainIdentity,
      { ...configFor({ type: 'constant', value: true }), ownership: { enabled: false }, revision: 1 },
      { userId: 28 },
    );
    adapter.release(ctx);
    await adapter.prepare(ctx, [mainIdentity]);
    db.removeCollection('tenants');
    const scoped = await service.scopeQuery(ctx, mainIdentity, {});
    expect(await docs.model.count(scoped.query)).toBe(6);
  });

  it('uses null exclusively for an explicitly prepared table without the new configuration', async () => {
    const record = await db.getRepository('collections').findOne({ filter: { key: mainIdentity.collectionKey } });
    await record.update({ options: {} });
    adapter.release(ctx);
    await adapter.prepare(ctx, [mainIdentity]);
    expect(await service.resolveScopes(ctx, mainIdentity, {})).toBeNull();
    expect(await service.scopeQuery(ctx, mainIdentity, {})).toBeNull();
    expect(service.hasUnconditionalOwnership(ctx, mainIdentity)).toBe(false);
  });

  it('keeps valid transactions and rejects finished or foreign transactions', async () => {
    let finished: Transaction;
    await db.sequelize.transaction(async (transaction) => {
      finished = transaction;
      const scoped = await plan('B', 'read', { transaction });
      expect(scoped.query.transaction).toBe(transaction);
      expect(await docs.model.count(scoped.query)).toBe(2);
    });
    await expect(plan('B', 'read', { transaction: finished })).rejects.toThrow('transaction');
    const other = sqliteDatabase();
    try {
      await other.sequelize.transaction(async (transaction) => {
        await expect(plan('B', 'read', { transaction })).rejects.toThrow('transaction');
      });
    } finally {
      await other.close();
    }
  });

  it('rejects positional bindings instead of rewriting the caller SQL', async () => {
    await expect(plan('B', 'read', { bind: [200] })).rejects.toThrow('named');
  });

  it('does not publish authorization after its phase ends during context lookup', async () => {
    const tenants = db.getCollection('tenants').model;
    const findOne = tenants.findOne.bind(tenants);
    let resume: () => void;
    const delayed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    vi.spyOn(tenants, 'findOne').mockImplementationOnce(async (options) => {
      await delayed;
      return findOne(options);
    });
    const pending = plan();
    adapter.release(ctx);
    await adapter.prepare(ctx, [mainIdentity]);
    resume();
    await expect(pending).rejects.toThrow('phase');
  });

  it('captures the transaction before asynchronous context lookup', async () => {
    const tenants = db.getCollection('tenants').model;
    const findOne = tenants.findOne.bind(tenants);
    let resume: () => void;
    const delayed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    vi.spyOn(tenants, 'findOne').mockImplementationOnce(async (options) => {
      await delayed;
      return findOne(options);
    });
    await db.sequelize.transaction(async (transaction) => {
      const options: { transaction?: Transaction } = { transaction };
      const pending = plan('B', 'read', options);
      options.transaction = undefined;
      resume();
      expect((await pending).query.transaction).toBe(transaction);
    });
  });

  it('rejects a runtime collection replaced during asynchronous identity lookup', async () => {
    const tenants = db.getCollection('tenants').model;
    const findOne = tenants.findOne.bind(tenants);
    let resume: () => void;
    const delayed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    vi.spyOn(tenants, 'findOne').mockImplementationOnce(async (options) => {
      await delayed;
      return findOne(options);
    });
    const pending = plan();
    db.removeCollection('documents');
    db.collection({ name: 'documents', timestamps: false, fields: [{ name: 'tenantId', type: 'string' }] });
    resume();
    await expect(pending).rejects.toThrow('identity');
  });
});

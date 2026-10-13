import { ACL, literal, Op, Transaction, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey } from '../../access-control/config-store';
import { AccessCreationService, type AccessCreationPlan } from '../../access-control/creation';
import { AccessQueryService } from '../../access-control/query';
import type { AccessConfig } from '../../access-control/types';
import { seedAclScopes } from './acl-database';
import { configStore, mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, seedDatabase, sqliteDatabase } from './database';
import { configFor, exampleConfig, ownerCondition, participantCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('access-controlled creation (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let adapter: AccessAclScopeAdapter;
  let queries: AccessQueryService;
  let service: AccessCreationService;
  let store: ReturnType<typeof configStore>;
  let ctx: object;

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
        { name: 'amount', type: 'integer', defaultValue: 10 },
        { name: 'name', type: 'string', defaultValue: 'draft' },
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
    queries = new AccessQueryService(db, adapter, (collection) =>
      accessCollectionKey({
        ...mainIdentity,
        collectionKey: `${collection.name}-key`,
        collectionName: collection.name,
      }),
    );
    service = new AccessCreationService(db, adapter, queries);
    ctx = {};
    await adapter.prepare(ctx, [mainIdentity]);
  });

  afterEach(async () => {
    try {
      if (dialect === 'postgres')
        await db.sequelize.query(
          'DROP TABLE IF EXISTS "rolesResourcesScopesActions", "dataSourcesRolesResourcesScopesActions", ' +
            '"rolesResourcesScopes", "dataSourcesRolesResourcesScopes", ' +
            '"access_config_collections", "access_config_dataSourcesCollections", "tenantAccessRevisions", ' +
            '"access_documents", "access_participants", "access_links", "access_tenants", "verified_tenants"',
        );
    } finally {
      await db.close();
    }
  });

  async function configure(config: AccessConfig) {
    const previous = await store.read(mainIdentity);
    await store.save(mainIdentity, { ...config, revision: previous.revision }, { userId: 28 });
    adapter.release(ctx);
    await adapter.prepare(ctx, [mainIdentity]);
  }

  async function write(plan: AccessCreationPlan) {
    const records = [];
    for (const values of plan.values)
      records.push(await docs.repository.create({ values, transaction: plan.transaction }));
    return records;
  }

  async function create(values = [{ id: 100, amount: 10 }], tenantId: string | undefined = 'B', where = {}) {
    return service.withCreatedRecords(ctx, mainIdentity, { tenantId }, { values, where }, write);
  }

  it('injects current ownership, uses model defaults and returns only keys and affected count', async () => {
    const values = [{ id: 100, amount: 10 }];
    expect(await create(values)).toEqual({ keys: [100], affected: 1 });
    expect((await docs.model.findByPk(100)).get()).toMatchObject({ tenantId: 'B', name: 'draft', amount: 10 });
    expect(values).toEqual([{ id: 100, amount: 10 }]);
  });

  it('replaces null ownership and never creates new unassigned legacy data', async () => {
    expect(
      await service.withCreatedRecords(
        ctx,
        mainIdentity,
        { tenantId: 'B' },
        {
          values: [{ id: 100, tenantId: null, amount: 10 }],
        },
        write,
      ),
    ).toMatchObject({ affected: 1 });
    expect((await docs.model.findByPk(100)).getDataValue('tenantId')).toBe('B');
  });

  it('authorizes the generated primary key instead of requiring a client-supplied ID', async () => {
    docs.model.rawAttributes.id.autoIncrement = true;
    (docs.model as typeof docs.model & { refreshAttributes(): void }).refreshAttributes();
    if (dialect === 'postgres')
      await db.sequelize.query(
        'ALTER TABLE access_documents ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (START WITH 100)',
      );
    const result = await service.withCreatedRecords(
      ctx,
      mainIdentity,
      { tenantId: 'B' },
      { values: [{ amount: 10 }] },
      write,
    );
    expect(result.affected).toBe(1);
    expect(result.keys[0]).toEqual(expect.any(Number));
    expect((await docs.model.findByPk(result.keys[0])).getDataValue('tenantId')).toBe('B');
  });

  it('snapshots caller conditions and values before awaiting and gives the writer independent field copies', async () => {
    const values = [{ id: 100, amount: 10 }];
    const where = { amount: { [Op.lt]: 100 } };
    const promise = service.withCreatedRecords(
      ctx,
      mainIdentity,
      { tenantId: 'B' },
      { values, where },
      async (plan) => {
        const copy = plan.values;
        copy[0].amount = 500;
        expect(plan.values[0].amount).toBe(10);
        return write(plan);
      },
    );
    values[0].amount = 500;
    where.amount[Op.lt] = 1;
    expect(await promise).toMatchObject({ affected: 1 });
    expect((await docs.model.findByPk(100)).getDataValue('amount')).toBe(10);
  });

  it.each(['explicit', 'generated'])(
    'rejects an afterCreate hook redirecting an %s primary key to an existing authorized row',
    async (mode) => {
      await configure(
        configFor({
          type: 'compare',
          operator: 'lt',
          left: { type: 'field', path: 'amount' },
          right: { type: 'literal', value: 100 },
        }),
      );
      await docs.model.update({ amount: 10 }, { where: { id: 3 } });
      if (mode === 'generated') {
        docs.model.rawAttributes.id.autoIncrement = true;
        (docs.model as typeof docs.model & { refreshAttributes(): void }).refreshAttributes();
        if (dialect === 'postgres')
          await db.sequelize.query(
            'ALTER TABLE access_documents ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (START WITH 100)',
          );
      }
      docs.model.addHook('afterCreate', (record) => {
        record.setDataValue('id', 3);
      });
      const notified = vi.fn();
      await expect(
        service.withCreatedRecords(
          ctx,
          mainIdentity,
          { tenantId: 'B' },
          {
            values: [mode === 'explicit' ? { id: 100, amount: 200 } : { amount: 200 }],
          },
          async (plan) => {
            plan.transaction.afterCommit(notified);
            return write(plan);
          },
        ),
      ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(await docs.model.count({ where: { amount: 200, id: { [Op.ne]: 2 } } })).toBe(0);
      expect(notified).not.toHaveBeenCalled();
    },
  );

  it('does not accept an existing saved model as proof of creation', async () => {
    await expect(
      service.withCreatedRecords(
        ctx,
        mainIdentity,
        { tenantId: 'B' },
        { values: [{ id: 100, amount: 10 }] },
        async () => [await docs.model.findByPk(3)],
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });

  it('rejects extra inserted targets and removes the temporary INSERT observer', async () => {
    const before = db.sequelize.options.hooks?.afterQuery?.length ?? 0;
    await expect(
      service.withCreatedRecords(
        ctx,
        mainIdentity,
        { tenantId: 'B' },
        { values: [{ id: 100, amount: 10 }] },
        async (plan) => {
          const records = await write(plan);
          await docs.repository.create({
            values: { id: 101, amount: 10, tenantId: 'B' },
            transaction: plan.transaction,
          });
          return records;
        },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(db.sequelize.options.hooks?.afterQuery?.length ?? 0).toBe(before);
    expect(await docs.model.findByPk(100)).toBeNull();
    expect(await docs.model.findByPk(101)).toBeNull();
  });

  it('preserves a database INSERT error and removes its observer even after extra writes', async () => {
    const before = db.sequelize.options.hooks?.afterQuery?.length ?? 0;
    await expect(
      service.withCreatedRecords(
        ctx,
        mainIdentity,
        { tenantId: 'B' },
        { values: [{ id: 100, amount: 10 }] },
        async (plan) => {
          const records = await write(plan);
          await docs.repository.create({ values: { id: 3, amount: 10, tenantId: 'B' }, transaction: plan.transaction });
          return records;
        },
      ),
    ).rejects.toMatchObject({ name: 'SequelizeUniqueConstraintError' });
    expect(db.sequelize.options.hooks?.afterQuery?.length ?? 0).toBe(before);
    expect(await docs.model.findByPk(100)).toBeNull();
  });

  it('does not grant creation from visibility alone and rolls back pending notifications', async () => {
    await configure(configFor({ type: 'constant', value: true }, 'visibility'));
    const notified = vi.fn();
    await expect(
      service.withCreatedRecords(
        ctx,
        mainIdentity,
        { tenantId: 'B' },
        {
          values: [{ id: 100, amount: 10 }],
        },
        async (plan) => {
          plan.transaction.afterCommit(notified);
          return write(plan);
        },
      ),
    ).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await docs.model.findByPk(100)).toBeNull();
    expect(notified).not.toHaveBeenCalled();
  });

  it('rejects forged ownership before invoking the writer', async () => {
    const writer = vi.fn();
    await expect(
      service.withCreatedRecords(
        ctx,
        mainIdentity,
        { tenantId: 'B' },
        {
          values: [{ id: 100, amount: 10, tenantId: 'H' }],
        },
        writer,
      ),
    ).rejects.toMatchObject({ code: 'ACCESS_OWNERSHIP_CHANGE_FORBIDDEN' });
    expect(writer).not.toHaveBeenCalled();
  });

  it.each(['missing', 'disabled'])('rejects a %s current tenant before invoking the writer', async (mode) => {
    if (mode === 'disabled') await db.getCollection('tenants').model.update({ enabled: false }, { where: { id: 'B' } });
    const writer = vi.fn();
    await expect(
      service.withCreatedRecords(
        ctx,
        mainIdentity,
        { tenantId: mode === 'missing' ? undefined : 'B' },
        {
          values: [{ id: 100, amount: 10 }],
        },
        writer,
      ),
    ).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
    expect(writer).not.toHaveBeenCalled();
  });

  it('does not require unrelated tenant context for a shared constant rule', async () => {
    await configure({ ...configFor({ type: 'constant', value: true }), ownership: { enabled: false } });
    await db.getCollection('tenants').model.update({ enabled: false }, { where: { id: 'B' } });
    expect(await create()).toMatchObject({ affected: 1 });
    expect((await docs.model.findByPk(100)).getDataValue('tenantId')).toBeNull();
    db.removeCollection('tenants');
    expect(await create([{ id: 101, amount: 10 }])).toMatchObject({ affected: 1 });
  });

  it('evaluates database defaults rather than incomplete request fields', async () => {
    await configure(
      configFor({
        type: 'compare',
        operator: 'eq',
        left: { type: 'field', path: 'name' },
        right: { type: 'literal', value: 'draft' },
      }),
    );
    expect(
      await service.withCreatedRecords(ctx, mainIdentity, { tenantId: 'B' }, { values: [{ id: 100 }] }, write),
    ).toMatchObject({ affected: 1 });
  });

  it('evaluates fields after beforeCreate hooks and rolls back unauthorized values', async () => {
    await configure(
      configFor({
        type: 'compare',
        operator: 'lt',
        left: { type: 'field', path: 'amount' },
        right: { type: 'literal', value: 100 },
      }),
    );
    docs.model.addHook('beforeCreate', (record) => {
      record.set('amount', 200);
    });
    await expect(create()).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await docs.model.findByPk(100)).toBeNull();
  });

  it.each(['default', 'hook'])(
    'rejects an unadapted foreign-key write supplied by a %s instead of the request',
    async (mode) => {
      docs.setField('parentId', {
        type: 'integer',
        field: 'parent_id',
        ...(mode === 'default' ? { defaultValue: 1 } : {}),
      });
      docs.setField('parent', { type: 'belongsTo', target: 'participants', foreignKey: 'parentId' });
      await db.sequelize.query('ALTER TABLE access_documents ADD COLUMN parent_id INTEGER');
      if (mode === 'hook')
        docs.model.addHook('beforeCreate', (record) => {
          record.set('parentId', 1);
        });
      await expect(create()).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(await docs.model.findByPk(100)).toBeNull();
    },
  );

  it('checks actual stored ownership despite presentation getters or hook changes', async () => {
    docs.model.rawAttributes.tenantId.get = () => 'B';
    (docs.model as typeof docs.model & { refreshAttributes(): void }).refreshAttributes();
    docs.model.addHook('beforeCreate', (record) => {
      record.setDataValue('tenantId', 'H');
    });
    await expect(create()).rejects.toMatchObject({ code: 'ACCESS_OWNERSHIP_CHANGE_FORBIDDEN' });
    expect(await docs.model.findByPk(100)).toBeNull();
  });

  it('uses SQL three-valued NOT semantics for a null field', async () => {
    await configure(
      configFor({
        type: 'not',
        child: {
          type: 'compare',
          operator: 'eq',
          left: { type: 'field', path: 'name' },
          right: { type: 'literal', value: 'blocked' },
        },
      }),
    );
    await expect(
      service.withCreatedRecords(
        ctx,
        mainIdentity,
        { tenantId: 'B' },
        { values: [{ id: 100, amount: 10, name: null }] },
        write,
      ),
    ).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await docs.model.findByPk(100)).toBeNull();
  });

  it('rolls back the whole batch when only one candidate satisfies role conditions', async () => {
    await expect(
      create(
        [
          { id: 100, amount: 10 },
          { id: 101, amount: 200 },
        ],
        'B',
        { amount: { [Op.lt]: 100 } },
      ),
    ).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await docs.model.count({ where: { id: { [Op.in]: [100, 101] } } })).toBe(0);
  });

  it('preserves the original writer failure and rolls back its inserts', async () => {
    await expect(
      service.withCreatedRecords(
        ctx,
        mainIdentity,
        { tenantId: 'B' },
        { values: [{ id: 100, amount: 10 }] },
        async (plan) => {
          await write(plan);
          throw null;
        },
      ),
    ).rejects.toBeNull();
    expect(await docs.model.findByPk(100)).toBeNull();
  });

  it('publishes afterCommit notifications only after a successful authorization', async () => {
    const notified = vi.fn();
    await service.withCreatedRecords(
      ctx,
      mainIdentity,
      { tenantId: 'B' },
      { values: [{ id: 100, amount: 10 }] },
      async (plan) => {
        plan.transaction.afterCommit(notified);
        return write(plan);
      },
    );
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it.each(['empty', 'too many', 'nested', 'unknown', 'virtual', 'foreign-key'])(
    'rejects %s inputs before writing',
    async (mode) => {
      if (mode === 'virtual') docs.setField('display', { type: 'virtual' });
      if (mode === 'foreign-key')
        docs.setField('parent', { type: 'belongsTo', target: 'participants', foreignKey: 'parentId' });
      const values =
        mode === 'empty'
          ? []
          : mode === 'too many'
            ? Array.from({ length: 1001 }, (_, index) => ({ id: 100 + index }))
            : [
                {
                  id: 100,
                  amount: 10,
                  ...{
                    nested: { participants: [{ id: 1 }] },
                    unknown: { missing: 'x' },
                    virtual: { display: 'x' },
                    'foreign-key': { parentId: 1 },
                  }[mode],
                },
              ];
      const writer = vi.fn();
      await expect(
        service.withCreatedRecords(ctx, mainIdentity, { tenantId: 'B' }, { values }, writer),
      ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(writer).not.toHaveBeenCalled();
    },
  );

  it.each(['count', 'duplicate', 'model', 'unsaved'])(
    'rejects invalid %s results from the trusted writer',
    async (mode) => {
      await expect(
        service.withCreatedRecords(
          ctx,
          mainIdentity,
          { tenantId: 'B' },
          {
            values: [
              { id: 100, amount: 10 },
              { id: 101, amount: 10 },
            ],
          },
          async (plan) => {
            const records = await write(plan);
            if (mode === 'count') return records.slice(0, 1);
            if (mode === 'duplicate') return [records[0], records[0]];
            if (mode === 'model') return [records[0], await db.getCollection('participants').model.findByPk(1)];
            return [records[0], docs.model.build({ id: 101, amount: 10, tenantId: 'B' })];
          },
        ),
      ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(await docs.model.findByPk(100)).toBeNull();
      expect(await docs.model.findByPk(101)).toBeNull();
    },
  );

  it.each(['phase', 'model'])('rolls back when the configuration %s changes during the write', async (mode) => {
    await expect(
      service.withCreatedRecords(
        ctx,
        mainIdentity,
        { tenantId: 'B' },
        { values: [{ id: 100, amount: 10 }] },
        async (plan) => {
          const records = await write(plan);
          if (mode === 'phase') adapter.release(ctx);
          else db.collections.set('documents', db.getCollection('participants'));
          return records;
        },
      ),
    ).rejects.toMatchObject({ code: mode === 'phase' ? 'INVALID_ACCESS_CONFIG_WRITE' : 'INVALID_ACCESS_MUTATION' });
    expect(await docs.model.findByPk(100)).toBeNull();
  });

  if (dialect === 'sqlite') {
    it('rejects generated SQLite primary keys with custom setters before writing', async () => {
      docs.model.rawAttributes.id.autoIncrement = true;
      docs.model.rawAttributes.id.set = function (value) {
        this.setDataValue('id', value == null ? value : 3);
      };
      (docs.model as typeof docs.model & { refreshAttributes(): void }).refreshAttributes();
      await configure(
        configFor({
          type: 'compare',
          operator: 'lt',
          left: { type: 'field', path: 'amount' },
          right: { type: 'literal', value: 100 },
        }),
      );
      await docs.model.update({ amount: 10 }, { where: { id: 3 } });
      const writer = vi.fn(write);
      await expect(
        service.withCreatedRecords(ctx, mainIdentity, { tenantId: 'B' }, { values: [{ amount: 200 }] }, writer),
      ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(writer).not.toHaveBeenCalled();
    });

    it('rejects relational ownership before invoking an unsupported SQLite writer', async () => {
      await configure(configFor(participantCondition));
      const writer = vi.fn();
      await expect(
        service.withCreatedRecords(ctx, mainIdentity, { tenantId: 'B' }, { values: [{ id: 100, amount: 10 }] }, writer),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_ACCESS_MUTATION' });
      expect(writer).not.toHaveBeenCalled();
    });
  }

  if (dialect === 'postgres') {
    it('evaluates defaults supplied by the database itself', async () => {
      delete docs.model.rawAttributes.name.defaultValue;
      (docs.model as typeof docs.model & { refreshAttributes(): void }).refreshAttributes();
      await db.sequelize.query("ALTER TABLE access_documents ALTER COLUMN name SET DEFAULT 'database draft'");
      await configure(
        configFor({
          type: 'compare',
          operator: 'eq',
          left: { type: 'field', path: 'name' },
          right: { type: 'literal', value: 'database draft' },
        }),
      );
      expect(await create()).toMatchObject({ affected: 1 });
      expect((await docs.model.findByPk(100)).getDataValue('name')).toBe('database draft');
    });

    it.each(['exists', 'not-exists'])(
      'rolls back creation when concurrent %s facts cause a serialization conflict',
      async (mode) => {
        await configure(
          configFor(mode === 'exists' ? participantCondition : { type: 'not', child: participantCondition }),
        );
        const participants = db.getCollection('participants').model;
        if (mode === 'exists')
          await participants.create({ id: 9, documentId: 100, businessTenant: 'B', canView: true });
        const notified = vi.fn();
        await expect(
          service.withCreatedRecords(
            ctx,
            mainIdentity,
            { tenantId: 'B' },
            { values: [{ id: 100, amount: 10 }] },
            async (plan) => {
              plan.transaction.afterCommit(notified);
              await db.sequelize.transaction(
                { isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE },
                async (changer) => {
                  await docs.model.findByPk(100, { transaction: changer });
                  if (mode === 'exists')
                    await participants.destroy({ where: { documentId: 100 }, transaction: changer });
                  else
                    await participants.create(
                      { id: 9, documentId: 100, businessTenant: 'B', canView: true },
                      { transaction: changer },
                    );
                },
              );
              return write(plan);
            },
          ),
        ).rejects.toMatchObject({ code: 'ACCESS_MUTATION_CONFLICT', status: 409 });
        expect(await docs.model.findByPk(100)).toBeNull();
        expect(notified).not.toHaveBeenCalled();
      },
    );

    it('denies creation started after relational ownership was revoked', async () => {
      await configure(configFor(participantCondition));
      const participants = db.getCollection('participants').model;
      await participants.create({ id: 9, documentId: 100, businessTenant: 'B', canView: true });
      await participants.destroy({ where: { documentId: 100 } });
      await expect(create()).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      expect(await docs.model.findByPk(100)).toBeNull();
    });

    it('preserves named role bindings without overwriting access bindings', async () => {
      expect(
        await service.withCreatedRecords(
          ctx,
          mainIdentity,
          { tenantId: 'B' },
          {
            values: [{ id: 100, amount: 10 }],
            where: literal('"documents"."amount" < $tac_scope0_0'),
            bind: { tac_scope0_0: 100 },
          },
          write,
        ),
      ).toMatchObject({ affected: 1 });
    });

    it('authorizes relational G using the actual inserted primary key', async () => {
      await configure(configFor(participantCondition));
      await db
        .getCollection('participants')
        .model.create({ id: 9, documentId: 100, businessTenant: 'B', canView: true });
      expect(await create()).toMatchObject({ affected: 1 });
    });
  }
});

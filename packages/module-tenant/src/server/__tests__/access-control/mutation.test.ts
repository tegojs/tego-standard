import { ACL, literal, Op, Transaction, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey } from '../../access-control/config-store';
import { AccessMutationService } from '../../access-control/mutation';
import { AccessQueryService } from '../../access-control/query';
import type { AccessConfig } from '../../access-control/types';
import { seedAclScopes } from './acl-database';
import { configStore, mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, seedDatabase, sqliteDatabase } from './database';
import { configFor, exampleConfig, ownerCondition, participantCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('existing access mutations (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let adapter: AccessAclScopeAdapter;
  let queries: AccessQueryService;
  let service: AccessMutationService;
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
    queries = new AccessQueryService(db, adapter, (collection) =>
      accessCollectionKey({
        ...mainIdentity,
        collectionKey: `${collection.name}-key`,
        collectionName: collection.name,
      }),
    );
    service = new AccessMutationService(db, adapter, queries);
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

  async function read(id: number) {
    return (await docs.model.findByPk(id))?.get();
  }

  async function update(keys: Array<string | number>, values: Record<string, unknown>, tenantId = 'B', where = {}) {
    return service.withExistingRecords(
      ctx,
      mainIdentity,
      { tenantId },
      {
        operation: 'update',
        keys,
        values,
        where,
      },
      async (plan) => {
        for (const record of plan.records)
          await docs.repository.update({
            filterByTk: record.get('id'),
            values: plan.valuesFor(record),
            transaction: plan.transaction,
          });
      },
    );
  }

  it('updates owned records and returns a minimal success without re-reading the response', async () => {
    expect(await update([3], { name: 'edited' })).toEqual({ keys: [3], affected: 1 });
    expect(await read(3)).toMatchObject({ tenantId: 'B', name: 'edited' });
  });

  it('does not give writable access to records matched only by visibility', async () => {
    await expect(update([1], { name: 'forged' })).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await read(1)).toMatchObject({ tenantId: 'H', name: 'D1' });
  });

  it('does not authorize the old record using the proposed new field values', async () => {
    await configure(
      configFor({
        type: 'compare',
        operator: 'eq',
        left: { type: 'field', path: 'name' },
        right: { type: 'literal', value: 'draft' },
      }),
    );
    await expect(update([3], { name: 'draft' })).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect((await read(3)).name).toBe('D3');
  });

  it('allows a valid state change to leave the old ownership rule', async () => {
    await configure(
      configFor({
        type: 'compare',
        operator: 'eq',
        left: { type: 'field', path: 'name' },
        right: { type: 'literal', value: 'D3' },
      }),
    );
    expect(await update([3], { name: 'submitted' })).toEqual({ keys: [3], affected: 1 });
    const scoped = await queries.scopeQuery(ctx, mainIdentity, { tenantId: 'B' });
    expect(await docs.model.count(scoped.query)).toBe(0);
    expect((await read(3)).name).toBe('submitted');
  });

  it('rejects an entire explicitly selected batch before any callback runs', async () => {
    const callback = vi.fn();
    await expect(
      service.withExistingRecords(
        ctx,
        mainIdentity,
        { tenantId: 'B' },
        {
          operation: 'update',
          keys: [3, 1],
          values: { name: 'edited' },
        },
        callback,
      ),
    ).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(callback).not.toHaveBeenCalled();
    expect((await read(3)).name).toBe('D3');
  });

  it('keeps the caller role and request predicates for writes', async () => {
    await expect(update([3], { name: 'edited' }, 'B', { amount: { [Op.lt]: 200 } })).rejects.toMatchObject({
      code: 'ACCESS_RECORD_UNAVAILABLE',
    });
    expect(await update([3], { name: 'edited' }, 'B', { amount: { [Op.gte]: 200 } })).toMatchObject({ affected: 1 });
  });

  it('does not permit a requested ownership transfer', async () => {
    await expect(update([3], { tenantId: 'H', name: 'edited' })).rejects.toMatchObject({
      code: 'ACCESS_OWNERSHIP_CHANGE_FORBIDDEN',
    });
    expect(await read(3)).toMatchObject({ tenantId: 'B', name: 'D3' });
    await update([3], { tenantId: 'B', name: 'same owner' });
    expect((await read(3)).tenantId).toBe('B');
  });

  it('rolls back a forbidden ownership change made by server hooks or the writer', async () => {
    await expect(
      service.withExistingRecords(
        ctx,
        mainIdentity,
        { tenantId: 'B' },
        {
          operation: 'update',
          keys: [3],
          values: { name: 'edited' },
        },
        async (plan) => {
          await plan.records[0].update({ tenantId: 'H', name: 'edited' }, { transaction: plan.transaction });
        },
      ),
    ).rejects.toMatchObject({ code: 'ACCESS_OWNERSHIP_CHANGE_FORBIDDEN' });
    expect(await read(3)).toMatchObject({ tenantId: 'B', name: 'D3' });
  });

  it('checks stored ownership instead of a presentation getter', async () => {
    docs.model.rawAttributes.tenantId.get = function () {
      return 'H';
    };
    (docs.model as typeof docs.model & { refreshAttributes(): void }).refreshAttributes();
    await expect(update([3], { tenantId: 'H', name: 'forged' })).rejects.toMatchObject({
      code: 'ACCESS_OWNERSHIP_CHANGE_FORBIDDEN',
    });
    expect((await docs.model.findByPk(3)).getDataValue('name')).toBe('D3');
  });

  it('preserves an original non-Error failure from the trusted writer', async () => {
    await expect(
      service.withExistingRecords(
        ctx,
        mainIdentity,
        { tenantId: 'B' },
        {
          operation: 'update',
          keys: [3],
          values: { name: 'edited' },
        },
        async () => {
          throw null;
        },
      ),
    ).rejects.toBeNull();
    expect((await read(3)).name).toBe('D3');
  });

  it.each(['CASCADE', 'SET NULL'])('rejects deletion with unadapted %s changes to other records', async (onDelete) => {
    db.referenceMap.addReference({
      sourceCollectionName: 'participants',
      sourceField: 'documentId',
      targetCollectionName: 'documents',
      targetField: 'id',
      onDelete,
      priority: 'user',
    });
    const writer = vi.fn();
    await expect(
      service.withExistingRecords(
        ctx,
        mainIdentity,
        { tenantId: 'B' },
        {
          operation: 'destroy',
          keys: [3],
        },
        writer,
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_ACCESS_MUTATION' });
    expect(writer).not.toHaveBeenCalled();
    expect(await read(3)).toBeDefined();
  });

  it('claims a legacy record only on a successful ownership-authorized edit', async () => {
    await configure(configFor({ type: 'isNull', operand: { type: 'field', path: 'tenantId' } }));
    expect(await update([5], { name: 'claimed' })).toMatchObject({ affected: 1 });
    expect(await read(5)).toMatchObject({ tenantId: 'B', name: 'claimed' });
    await expect(update([5], { name: 'again' }, 'C')).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
  });

  it('reports visible legacy data as read-only when only V matches', async () => {
    await configure({
      ...configFor(ownerCondition),
      rules: [
        ...configFor(ownerCondition).rules,
        {
          ...configFor({ type: 'isNull', operand: { type: 'field', path: 'tenantId' } }, 'visibility').rules[0],
          id: 'legacy-read',
        },
      ],
    });
    await expect(update([5], { name: 'edited' })).rejects.toMatchObject({ code: 'LEGACY_DATA_READ_ONLY' });
    expect((await read(5)).tenantId).toBeNull();
  });

  it('does not reveal legacy status through a record denied by role predicates', async () => {
    await configure(configFor({ type: 'isNull', operand: { type: 'field', path: 'tenantId' } }, 'visibility'));
    await expect(update([5], { name: 'edited' }, 'B', { amount: 100 })).rejects.toMatchObject({
      code: 'ACCESS_RECORD_UNAVAILABLE',
    });
  });

  it('never deletes unassigned legacy records directly, even when G permits them', async () => {
    await configure(configFor({ type: 'isNull', operand: { type: 'field', path: 'tenantId' } }));
    await expect(
      service.withExistingRecords(
        ctx,
        mainIdentity,
        { tenantId: 'B' },
        {
          operation: 'destroy',
          keys: [5],
        },
        async (plan) => {
          await docs.repository.destroy({ filterByTk: 5, transaction: plan.transaction });
        },
      ),
    ).rejects.toMatchObject({ code: 'LEGACY_DATA_READ_ONLY' });
    expect(await read(5)).toBeDefined();
  });

  it('can delete an owned record with G', async () => {
    expect(
      await service.withExistingRecords(
        ctx,
        mainIdentity,
        { tenantId: 'B' },
        {
          operation: 'destroy',
          keys: [3],
        },
        async (plan) => {
          await docs.repository.destroy({ filterByTk: 3, transaction: plan.transaction });
        },
      ),
    ).toEqual({ keys: [3], affected: 1 });
    expect(await read(3)).toBeUndefined();
  });

  it('rolls back a failed writer and its legacy claim without firing commit effects', async () => {
    await configure(configFor({ type: 'isNull', operand: { type: 'field', path: 'tenantId' } }));
    const notified = vi.fn();
    await expect(
      service.withExistingRecords(
        ctx,
        mainIdentity,
        { tenantId: 'B' },
        {
          operation: 'update',
          keys: [5],
          values: { name: 'edited' },
        },
        async (plan) => {
          plan.transaction.afterCommit(notified);
          const record = plan.records[0];
          await record.update(plan.valuesFor(record), { transaction: plan.transaction });
          throw new Error('business failed');
        },
      ),
    ).rejects.toThrow('business failed');
    expect(await read(5)).toMatchObject({ tenantId: null, name: 'D5' });
    expect(notified).not.toHaveBeenCalled();
  });

  it('requires an active tenant for legacy claim even if the rule itself needs no identity', async () => {
    await configure(configFor({ type: 'isNull', operand: { type: 'field', path: 'tenantId' } }));
    await db.getCollection('tenants').model.update({ enabled: false }, { where: { id: 'B' } });
    await expect(update([5], { name: 'edited' })).rejects.toThrow(/disabled/);
    expect((await read(5)).tenantId).toBeNull();
  });

  it('does not claim a shared table with ownership management disabled', async () => {
    await configure({ ...configFor({ type: 'constant', value: true }), ownership: { enabled: false } });
    await update([5], { name: 'shared' });
    expect(await read(5)).toMatchObject({ name: 'shared', tenantId: null });
  });

  it('does not require an irrelevant tenant identity for a shared constant rule', async () => {
    await configure({ ...configFor({ type: 'constant', value: true }), ownership: { enabled: false } });
    await db.getCollection('tenants').model.update({ enabled: false }, { where: { id: 'B' } });
    await expect(update([5], { name: 'shared' })).resolves.toMatchObject({ affected: 1 });
    expect(await read(5)).toMatchObject({ name: 'shared', tenantId: null });
  });

  it('rolls back if the registered collection identity changes during the writer', async () => {
    const getCollection = db.getCollection.bind(db);
    let replaced = false;
    const replacement = Object.create(docs) as Collection;
    const spy = vi
      .spyOn(db, 'getCollection')
      .mockImplementation((name) => (replaced && name === 'documents' ? replacement : getCollection(name)));
    try {
      await expect(
        service.withExistingRecords(
          ctx,
          mainIdentity,
          { tenantId: 'B' },
          {
            operation: 'update',
            keys: [3],
            values: { name: 'must rollback' },
          },
          async (plan) => {
            await plan.records[0].update(plan.valuesFor(plan.records[0]), { transaction: plan.transaction });
            replaced = true;
          },
        ),
      ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    } finally {
      spy.mockRestore();
    }
    expect((await read(3)).name).toBe('D3');
  });

  it.each([
    ['empty', []],
    ['missing', [999]],
    ['partially missing', [3, 999]],
    ['non-finite', [NaN]],
    ['object', [{}]],
    ['too many', Array.from({ length: 1001 }, (_, i) => i)],
  ])('rejects invalid or missing explicit targets (%s)', async (_label, keys) => {
    await expect(update(keys as number[], { name: 'edited' })).rejects.toMatchObject({
      code: ['missing', 'partially missing'].includes(_label as string)
        ? 'ACCESS_RECORD_UNAVAILABLE'
        : 'INVALID_ACCESS_MUTATION',
    });
    expect((await read(3)).name).toBe('D3');
  });

  it('normalizes integer IDs without counting duplicate representations twice', async () => {
    expect(await update([3, '3', '03'], { name: 'edited' })).toEqual({ keys: [3], affected: 1 });
  });

  it('uses a bounded number of root authorization queries for a batch', async () => {
    const keys = Array.from({ length: 20 }, (_, index) => 100 + index);
    await docs.model.bulkCreate(keys.map((id) => ({ id, name: `batch-${id}`, tenantId: 'B', amount: 1 })));
    const counts: number[] = [];
    for (const selected of [[3], keys]) {
      await db.sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE }, async (transaction) => {
        const spy = vi.spyOn(db.sequelize, 'query');
        try {
          const plan = await service.authorizeExisting(
            ctx,
            mainIdentity,
            { tenantId: 'B' },
            {
              operation: 'update',
              keys: selected,
              values: { name: 'edited' },
            },
            transaction,
          );
          expect(plan.records).toHaveLength(selected.length);
          counts.push(
            spy.mock.calls.filter(
              ([sql]) => typeof sql === 'string' && /SELECT .*FROM ["`]access_documents["`]/s.test(sql),
            ).length,
          );
        } finally {
          spy.mockRestore();
        }
      });
    }
    expect(counts).toEqual([2, 2]);
  });

  it('takes an immutable snapshot of the caller values, keys and role conditions before awaiting', async () => {
    const request = {
      operation: 'update' as const,
      keys: [3],
      values: { name: 'snapshot' },
      where: { amount: { [Op.gte]: 200 } },
    };
    const pending = service.withExistingRecords(ctx, mainIdentity, { tenantId: 'B' }, request, async (plan) => {
      expect(plan.records).toHaveLength(1);
      const record = plan.records[0];
      expect(plan.valuesFor(record)).toEqual({ name: 'snapshot' });
      const patch = plan.valuesFor(record);
      patch.name = 'caller cannot replace the plan';
      await record.update(plan.valuesFor(record), { transaction: plan.transaction });
    });
    request.keys.push(1);
    request.values.name = 'forged';
    request.where.amount[Op.gte] = 1000;
    await expect(pending).resolves.toEqual({ keys: [3], affected: 1 });
    expect((await read(3)).name).toBe('snapshot');
  });

  it('rejects nested association writes and key changes until their write adapters are present', async () => {
    await expect(update([3], { participants: [] })).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    await expect(update([3], { id: 1 })).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });

  it('does not fall back to old authorization for an unprepared or unmigrated collection', async () => {
    adapter.release(ctx);
    await expect(update([3], { name: 'edited' })).rejects.toThrow('identity');
    const record = await db.getRepository('collections').findOne({ filter: { key: mainIdentity.collectionKey } });
    await record.update({ options: {} });
    await adapter.prepare(ctx, [mainIdentity]);
    await expect(update([3], { name: 'edited' })).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });

  it('requires an actual active write transaction for direct authorization', async () => {
    await expect(
      service.authorizeExisting(
        ctx,
        mainIdentity,
        { tenantId: 'B' },
        {
          operation: 'update',
          keys: [3],
          values: { name: 'edited' },
        },
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    let finished!: Transaction;
    await db.sequelize.transaction(async (transaction) => {
      finished = transaction;
    });
    await expect(
      service.authorizeExisting(
        ctx,
        mainIdentity,
        { tenantId: 'B' },
        {
          operation: 'update',
          keys: [3],
          values: { name: 'edited' },
        },
        finished,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });

  it('rejects relational G on SQLite and requires serializable isolation on PostgreSQL', async () => {
    await configure(configFor(participantCondition));
    if (dialect === 'sqlite') {
      await expect(update([1], { name: 'edited' })).rejects.toMatchObject({ code: 'UNSUPPORTED_ACCESS_MUTATION' });
    } else {
      await db.sequelize.transaction(
        { isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED },
        async (transaction) => {
          await expect(
            service.authorizeExisting(
              ctx,
              mainIdentity,
              { tenantId: 'B' },
              {
                operation: 'update',
                keys: [1],
                values: { name: 'edited' },
              },
              transaction,
            ),
          ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
        },
      );
      expect(await update([1], { name: 'related owner' })).toMatchObject({ affected: 1 });
      expect(await read(1)).toMatchObject({ tenantId: 'H', name: 'related owner' });
    }
  });

  it('also treats role SQL predicates as possible relational authorization facts', async () => {
    const request = { operation: 'update' as const, keys: [3], values: { name: 'edited' }, where: literal('1 = 1') };
    if (dialect === 'sqlite') {
      await expect(
        service.withExistingRecords(ctx, mainIdentity, { tenantId: 'B' }, request, vi.fn()),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_ACCESS_MUTATION' });
    } else {
      await db.sequelize.transaction(
        { isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED },
        async (transaction) => {
          await expect(
            service.authorizeExisting(ctx, mainIdentity, { tenantId: 'B' }, request, transaction),
          ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
        },
      );
    }
  });

  if (dialect === 'postgres') {
    it('preserves bound role SQL and does not collide with compiled authorization bindings', async () => {
      const values = { name: 'bound' };
      expect(
        await service.withExistingRecords(
          ctx,
          mainIdentity,
          { tenantId: 'B' },
          {
            operation: 'update',
            keys: [3],
            values,
            where: literal('"documents"."amount" >= $tac_scope0_0'),
            bind: { tac_scope0_0: 200 },
          },
          async (plan) => {
            await plan.records[0].update(plan.valuesFor(plan.records[0]), { transaction: plan.transaction });
          },
        ),
      ).toMatchObject({ affected: 1 });
      expect(values).toEqual({ name: 'bound' });
      expect((await read(3)).name).toBe('bound');
    });

    it('allows only one actual service callback to claim a legacy row concurrently', async () => {
      await configure(configFor({ type: 'isNull', operand: { type: 'field', path: 'tenantId' } }));
      let startSecond!: Promise<unknown>;
      const secondWriter = vi.fn();
      await service.withExistingRecords(
        ctx,
        mainIdentity,
        { tenantId: 'B' },
        {
          operation: 'update',
          keys: [5],
          values: { name: 'first' },
        },
        async (plan) => {
          // Attach a rejection handler immediately, while the first transaction still holds the root lock.
          startSecond = service
            .withExistingRecords(
              ctx,
              mainIdentity,
              { tenantId: 'C' },
              {
                operation: 'update',
                keys: [5],
                values: { name: 'second' },
              },
              secondWriter,
            )
            .then(
              () => ({ success: true }),
              (error) => error,
            );
          await vi.waitFor(
            async () => {
              const [waiting] = await db.sequelize.query(
                "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%access_documents%'",
              );
              expect(waiting).toHaveLength(1);
            },
            { timeout: 5000, interval: 20 },
          );
          await plan.records[0].update(plan.valuesFor(plan.records[0]), { transaction: plan.transaction });
        },
      );
      expect(await startSecond).toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      expect(secondWriter).not.toHaveBeenCalled();
      expect(await read(5)).toMatchObject({ tenantId: 'B', name: 'first' });
    });

    it('denies actual writes begun after a relationship revocation commits', async () => {
      await configure(configFor(participantCondition));
      await db.getCollection('participants').model.destroy({ where: { documentId: 1, businessTenant: 'B' } });
      await expect(update([1], { name: 'denied' })).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      expect((await read(1)).name).toBe('D1');
    });

    it('includes mutable tenant hierarchy facts in the actual serializable write', async () => {
      await configure(
        configFor({
          type: 'tenantRelation',
          tenant: { type: 'field', path: 'tenantId' },
          relation: 'ancestor',
          includeSelf: true,
        }),
      );
      await expect(
        service.withExistingRecords(
          ctx,
          mainIdentity,
          { tenantId: 'H' },
          {
            operation: 'update',
            keys: [3],
            values: { name: 'must rollback' },
          },
          async (plan) => {
            await db.sequelize.transaction(
              { isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE },
              async (changer) => {
                await docs.model.findByPk(3, { attributes: ['amount'], transaction: changer });
                await db
                  .getCollection('tenants')
                  .model.update({ parentId: null }, { where: { id: 'B' }, transaction: changer });
              },
            );
            await plan.records[0].update(plan.valuesFor(plan.records[0]), { transaction: plan.transaction });
          },
        ),
      ).rejects.toMatchObject({ code: 'ACCESS_MUTATION_CONFLICT', status: 409 });
      expect(await read(3)).toMatchObject({ tenantId: 'B', name: 'D3' });
      await expect(
        service.withExistingRecords(
          ctx,
          mainIdentity,
          { tenantId: 'H' },
          {
            operation: 'update',
            keys: [3],
            values: { name: 'revoked' },
          },
          vi.fn(),
        ),
      ).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    });

    it.each(['exists', 'not-exists'])('rolls back an actual service write with inconsistent %s facts', async (mode) => {
      await configure(
        configFor(mode === 'exists' ? participantCondition : { type: 'not', child: participantCondition }),
      );
      const id = mode === 'exists' ? 1 : 2;
      const notified = vi.fn();
      await expect(
        service.withExistingRecords(
          ctx,
          mainIdentity,
          { tenantId: 'B' },
          {
            operation: 'update',
            keys: [id],
            values: { name: 'must rollback' },
          },
          async (plan) => {
            plan.transaction.afterCommit(notified);
            await db.sequelize.transaction(
              { isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE },
              async (changer) => {
                await docs.model.findByPk(id, { attributes: ['amount'], transaction: changer });
                if (mode === 'exists')
                  await db.getCollection('participants').model.destroy({
                    where: { documentId: 1, businessTenant: 'B' },
                    transaction: changer,
                  });
                else
                  await db.getCollection('participants').model.create(
                    {
                      id: 9,
                      documentId: 2,
                      businessTenant: 'B',
                      canView: true,
                    },
                    { transaction: changer },
                  );
              },
            );
            await plan.records[0].update(plan.valuesFor(plan.records[0]), { transaction: plan.transaction });
          },
        ),
      ).rejects.toMatchObject({ code: 'ACCESS_MUTATION_CONFLICT', status: 409 });
      expect((await read(id)).name).toBe(`D${id}`);
      expect(notified).not.toHaveBeenCalled();
    });
  }
});

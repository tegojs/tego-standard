import { ACL, literal, Transaction, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { AccessHasManyService } from '../../access-control/has-many';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessMutationService } from '../../access-control/mutation';
import { AccessQueryService } from '../../access-control/query';
import { AccessReferenceService } from '../../access-control/references';
import type { TargetForeignKeyMutationEntry } from '../../access-control/target-foreign-key';
import type { AccessCondition, AccessConfig } from '../../access-control/types';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const childIdentity = { dataSourceKey: 'main', collectionKey: 'children-key', collectionName: 'children' };
const authenticated = { tenantId: 'B' };

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('access has-many (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let children: Collection;
  let store: AccessConfigStore;
  let adapter: AccessAclScopeAdapter;
  let queries: AccessQueryService;
  let service: AccessHasManyService;
  let ctx: object;
  const stableKey = (collection: Collection) =>
    accessCollectionKey({ ...mainIdentity, collectionKey: `${collection.name}-key`, collectionName: collection.name });

  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl) : sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    const fields = [
      { name: 'id', type: 'integer', primaryKey: true },
      { name: 'tenantId', type: 'string' },
      { name: 'name', type: 'string' },
    ];
    docs = db.collection({ name: 'documents', tableName: 'hm_documents', timestamps: false, fields });
    children = db.collection({
      name: 'children',
      tableName: 'hm_children',
      timestamps: false,
      fields: [...fields, { name: 'documentId', type: 'integer', field: 'document_id' }],
    });
    docs.setField('children', { type: 'hasMany', target: 'children', foreignKey: 'documentId' });
    children.setField('document', { type: 'belongsTo', target: 'documents', foreignKey: 'documentId' });
    const tenants = db.collection({
      name: 'tenants',
      tableName: 'hm_tenants',
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
    await children.repository.create({
      values: [
        { id: 101, tenantId: 'B', name: 'Owned', documentId: null },
        { id: 102, tenantId: 'H', name: 'Shared', documentId: null },
        { id: 103, tenantId: 'C', name: 'Hidden', documentId: null },
        { id: 104, tenantId: null, name: 'Legacy', documentId: null },
        { id: 105, tenantId: 'B', name: 'Owned', documentId: 3 },
        { id: 106, tenantId: 'B', name: 'Owned', documentId: 4 },
      ],
    });
    await db.getRepository('collections').create({ values: { key: 'children-key', name: 'children' } });
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
    await store.save(childIdentity, config, { userId: 28 });
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    queries = new AccessQueryService(db, adapter, stableKey);
    service = new AccessHasManyService(
      db,
      adapter,
      queries,
      new AccessMutationService(db, adapter, queries),
      new AccessReferenceService(db, adapter, queries),
    );
    ctx = {};
    await adapter.prepare(ctx, [mainIdentity, childIdentity]);
  });

  afterEach(async () => {
    try {
      if (dialect === 'postgres')
        await db.sequelize.query(
          'DROP TABLE IF EXISTS "rolesResourcesScopesActions", "dataSourcesRolesResourcesScopesActions", ' +
            '"rolesResourcesScopes", "dataSourcesRolesResourcesScopes", "access_config_collections", ' +
            '"access_config_dataSourcesCollections", "tenantAccessRevisions", "hm_children", "hm_documents", "hm_tenants", "hm_readers"',
        );
    } finally {
      await db.close();
    }
  });

  const mutate = (operation: 'add' | 'remove' | 'set', targetKeys: number[], sourceKey = 3, extra = {}) =>
    service.withChildren(ctx, mainIdentity, childIdentity, authenticated, {
      association: 'children',
      operation,
      sourceKey,
      targetKeys,
      ...extra,
    });
  const child = (id: number) => children.model.findByPk(id);
  const parent = (id: number) => docs.model.findByPk(id);
  async function linked(sourceKey = 3) {
    const rows = await children.model.findAll({ where: { documentId: sourceKey }, order: [['id', 'ASC']] });
    return rows.map((row) => row.getDataValue('id'));
  }
  async function configure(identity: typeof mainIdentity, condition: AccessCondition) {
    const previous = await store.read(identity);
    await store.save(
      identity,
      {
        ...previous!,
        revision: previous!.revision,
        rules: [
          { ...configFor(condition).rules[0], id: 'editable' },
          ...previous!.rules.filter((r) => r.category === 'visibility'),
        ],
      },
      { userId: 28 },
    );
    adapter.release(ctx);
    await adapter.prepare(ctx, [mainIdentity, childIdentity]);
  }
  const withLegacy = {
    type: 'any',
    children: [ownerCondition, { type: 'isNull', operand: { type: 'field', path: 'tenantId' } }],
  } as AccessCondition;

  if (dialect === 'sqlite') {
    it('rejects relationship writes on unvalidated dialects', async () => {
      await expect(mutate('add', [101])).rejects.toMatchObject({ code: 'UNSUPPORTED_ACCESS_MUTATION' });
      expect(await linked()).toEqual([105]);
    });
    it('rejects caller-owned relationship writes on an unvalidated dialect', async () => {
      const transaction = await db.sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE });
      try {
        await expect(
          service.withChildrenInTransaction(
            ctx,
            mainIdentity,
            childIdentity,
            authenticated,
            { association: 'children', operation: 'add', sourceKey: 3, targetKeys: [101] },
            transaction,
          ),
        ).rejects.toMatchObject({ code: 'UNSUPPORTED_ACCESS_MUTATION' });
      } finally {
        await transaction.rollback();
      }
      expect(await linked()).toEqual([105]);
    });
    return;
  }

  describe('caller-owned child transactions', () => {
    const begin = (options = {}) =>
      db.sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE, ...options });
    const finish = async (transaction: Transaction) => {
      if (!(transaction as Transaction & { finished?: string }).finished) await transaction.rollback();
    };
    const update = (transaction: Transaction, extra = {}, entry?: TargetForeignKeyMutationEntry) =>
      service.withChildrenInTransaction(
        ctx,
        mainIdentity,
        childIdentity,
        authenticated,
        { association: 'children', operation: 'add', sourceKey: 3, targetKeys: [101], ...extra },
        transaction,
        entry,
      );

    it.each([false, true])('leaves all writes and notifications pending for caller commit=%s', async (commit) => {
      const transaction = await begin();
      let notified = 0;
      children.model.addHook('afterUpdate', (_row, options) => {
        options.transaction.afterCommit(() => {
          notified++;
        });
      });
      try {
        await docs.model.update({ name: 'Prior write' }, { where: { id: 3 }, transaction });
        expect(await update(transaction, { sourceValues: { name: 'Changed' } })).toEqual({
          keys: [101],
          affected: 1,
          sourceResult: { keys: [3], affected: 1 },
        });
        expect((await child(101)).getDataValue('documentId')).toBeNull();
        expect((await parent(3)).getDataValue('name')).toBe('Owned');
        expect((await children.model.findByPk(101, { transaction })).getDataValue('documentId')).toBe(3);
        expect(notified).toBe(0);
        if (commit) await transaction.commit();
        else await transaction.rollback();
      } finally {
        await finish(transaction);
      }
      expect((await child(101)).getDataValue('documentId')).toBe(commit ? 3 : null);
      expect((await parent(3)).getDataValue('name')).toBe(commit ? 'Changed' : 'Owned');
      expect(notified).toBe(commit ? 1 : 0);
    });

    it.each([
      ['remove', [105], [], 1],
      ['set', [101], [101], 2],
      ['set', [105], [105], 0],
    ] as const)('preserves %s actual-change semantics (%j)', async (operation, targetKeys, expected, affected) => {
      const transaction = await begin();
      try {
        const result = await update(transaction, { operation, targetKeys: [...targetKeys] });
        expect(result.affected).toBe(affected);
        await transaction.commit();
      } finally {
        await finish(transaction);
      }
      expect(await linked()).toEqual(expected);
    });

    it.each([
      { sourceKey: 1 },
      { sourceKey: 4 },
      { sourceWhere: { id: 4 } },
      { targetKeys: [102] },
      { targetKeys: [103] },
      { targetKeys: [999] },
    ])('checks source G and every changed child G: %j', async (patch) => {
      const transaction = await begin();
      try {
        await expect(update(transaction, patch)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
        expect((transaction as Transaction & { finished?: string }).finished).toBeUndefined();
      } finally {
        await finish(transaction);
      }
      expect(await linked()).toEqual([105]);
    });

    it.each(['read', 'write'] as const)('keeps finalized target %s predicates in caller writes', async (part) => {
      const transaction = await begin();
      try {
        await expect(
          update(
            transaction,
            {},
            {
              assertCurrent() {},
              targetReadScope: async () => ({ where: part === 'read' ? { id: 105 } : {} }),
              targetWriteScope: async () => ({ where: part === 'write' ? { id: 105 } : {} }),
            },
          ),
        ).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      } finally {
        await finish(transaction);
      }
      expect(await linked()).toEqual([105]);
    });

    it('retains an unchanged visibility-only child without granting a write', async () => {
      await children.model.update({ documentId: 3 }, { where: { id: 102 } });
      const transaction = await begin();
      try {
        expect(await update(transaction, { operation: 'set', targetKeys: [102, 105] })).toEqual({
          keys: [],
          affected: 0,
        });
        await transaction.commit();
      } finally {
        await finish(transaction);
      }
      expect(await linked()).toEqual([102, 105]);
      expect((await child(102)).getDataValue('tenantId')).toBe('H');
    });

    it('checks an implicitly removed child and rolls back earlier caller work', async () => {
      await children.model.update({ documentId: 3 }, { where: { id: 102 } });
      const transaction = await begin();
      try {
        await docs.model.update({ name: 'Prior write' }, { where: { id: 3 }, transaction });
        await expect(update(transaction, { operation: 'set' })).rejects.toMatchObject({
          code: 'ACCESS_RECORD_UNAVAILABLE',
        });
      } finally {
        await finish(transaction);
      }
      expect(await linked()).toEqual([102, 105]);
      expect((await parent(3)).getDataValue('name')).toBe('Owned');
    });

    it.each([false, true])('claims legacy source and target only in the caller commit=%s', async (commit) => {
      await configure(mainIdentity, withLegacy);
      await configure(childIdentity, withLegacy);
      const transaction = await begin();
      try {
        await update(transaction, { sourceKey: 5, targetKeys: [104] });
        expect((await parent(5)).getDataValue('tenantId')).toBeNull();
        expect((await child(104)).getDataValue('tenantId')).toBeNull();
        if (commit) await transaction.commit();
        else await transaction.rollback();
      } finally {
        await finish(transaction);
      }
      expect((await parent(5)).getDataValue('tenantId')).toBe(commit ? 'B' : null);
      expect((await child(104)).getDataValue('tenantId')).toBe(commit ? 'B' : null);
      expect((await child(104)).getDataValue('documentId')).toBe(commit ? 5 : null);
    });

    it('preserves a late hook error and leaves the transaction for caller rollback', async () => {
      const original = new Error('later child failed');
      let notifications = 0;
      children.model.addHook('afterUpdate', (row, options) => {
        options.transaction.afterCommit(() => {
          notifications++;
        });
        if (row.getDataValue('id') === 106) throw original;
      });
      const transaction = await begin();
      try {
        await expect(update(transaction, { targetKeys: [101, 106], sourceValues: { name: 'Changed' } })).rejects.toBe(
          original,
        );
        expect((transaction as Transaction & { finished?: string }).finished).toBeUndefined();
      } finally {
        await finish(transaction);
      }
      expect(await linked()).toEqual([105]);
      expect((await parent(3)).getDataValue('name')).toBe('Owned');
      expect(notifications).toBe(0);
    });

    it.each(['tenantId', 'documentId'])('rechecks a hook changing child %s', async (field) => {
      children.model.addHook('beforeUpdate', (row) => row.setDataValue(field, field === 'tenantId' ? 'C' : 4));
      const transaction = await begin();
      try {
        await expect(update(transaction)).rejects.toMatchObject({
          code: field === 'tenantId' ? 'ACCESS_OWNERSHIP_CHANGE_FORBIDDEN' : 'INVALID_ACCESS_MUTATION',
        });
      } finally {
        await finish(transaction);
      }
      expect((await child(101)).getDataValue('tenantId')).toBe('B');
      expect((await child(101)).getDataValue('documentId')).toBeNull();
    });

    it.each([undefined, null, {}])('rejects a missing or invalid caller transaction %j', async (transaction) => {
      await expect(update(transaction as Transaction)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(await linked()).toEqual([105]);
    });
    it('rejects insufficient isolation without upgrading or ending the caller transaction', async () => {
      const transaction = await begin({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED });
      try {
        await expect(update(transaction)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
        const [rows] = await db.sequelize.query("SELECT current_setting('transaction_isolation') AS isolation", {
          transaction,
        });
        expect((rows as Array<{ isolation: string }>)[0].isolation).toBe('read committed');
      } finally {
        await finish(transaction);
      }
      expect(await linked()).toEqual([105]);
    });
    it('rejects read-only and nested transactions without ending the caller root', async () => {
      const readOnly = await begin({ readOnly: true });
      try {
        await expect(update(readOnly)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
        expect((readOnly as Transaction & { finished?: string }).finished).toBeUndefined();
      } finally {
        await finish(readOnly);
      }
      const root = await begin();
      const nested = await db.sequelize.transaction({ transaction: root });
      try {
        await expect(update(nested)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
        expect((root as Transaction & { finished?: string }).finished).toBeUndefined();
      } finally {
        await nested.rollback();
        await finish(root);
      }
    });
    it('rejects finished and different-database transactions without replacements', async () => {
      const finished = await begin();
      await finished.commit();
      await expect(update(finished)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      const other = isolatedPostgresDatabase(postgresUrl!);
      const foreign = await other.sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE });
      try {
        await expect(update(foreign)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
        expect((foreign as Transaction & { finished?: string }).finished).toBeUndefined();
      } finally {
        await foreign.rollback();
        await other.close();
      }
      expect(await linked()).toEqual([105]);
    });
  });

  it('binds unassigned owned children and preserves all existing ownership', async () => {
    expect(await mutate('add', [101])).toEqual({ keys: [101], affected: 1 });
    expect(await linked()).toEqual([101, 105]);
    expect((await child(101)).getDataValue('tenantId')).toBe('B');
  });
  it('implements remove set and empty set using actual child foreign key changes', async () => {
    await mutate('set', [101, 106]);
    expect(await linked()).toEqual([101, 106]);
    expect((await child(105)).getDataValue('documentId')).toBeNull();
    await mutate('remove', [101]);
    expect(await linked()).toEqual([106]);
    await mutate('set', []);
    expect(await linked()).toEqual([]);
    expect((await parent(4)).getDataValue('tenantId')).toBe('C');
  });
  it.each([1, 4])('rejects a non-writable source %s', async (id) => {
    await expect(mutate('add', [101], id)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect((await child(101)).getDataValue('documentId')).toBeNull();
  });
  it.each([102, 103, 999])('rejects actual writes to a read-only hidden or missing child %s', async (id) => {
    await expect(mutate('add', [101, id])).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await linked()).toEqual([105]);
  });
  it('checks G for old children implicitly removed by set and rolls back the whole replacement', async () => {
    await children.model.update({ documentId: 3 }, { where: { id: 102 } });
    await expect(mutate('set', [101])).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await linked()).toEqual([102, 105]);
    expect((await child(101)).getDataValue('documentId')).toBeNull();
  });
  it('does not mistake an unchanged visibility-only child for an edit', async () => {
    await children.model.update({ documentId: 3 }, { where: { id: 102 } });
    expect(await mutate('set', [102, 105])).toEqual({ keys: [], affected: 0 });
    await mutate('add', [101, 102]);
    expect(await linked()).toEqual([101, 102, 105]);
    expect((await child(102)).getDataValue('tenantId')).toBe('H');
  });
  it('rejects a hidden old child even when not explicitly submitted', async () => {
    await children.model.update({ documentId: 3 }, { where: { id: 103 } });
    await expect(mutate('set', [])).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await linked()).toEqual([103, 105]);
  });
  it('intersects separate target read and update role predicates', async () => {
    await expect(mutate('add', [101], 3, { targetWhere: { id: 105 } })).rejects.toMatchObject({
      code: 'ACCESS_RECORD_UNAVAILABLE',
    });
    await expect(mutate('add', [101], 3, { targetReadWhere: { id: 105 } })).rejects.toMatchObject({
      code: 'ACCESS_RECORD_UNAVAILABLE',
    });
    await expect(mutate('add', [101], 3, { sourceWhere: { id: 4 } })).rejects.toMatchObject({
      code: 'ACCESS_RECORD_UNAVAILABLE',
    });
    expect(await linked()).toEqual([105]);
  });
  it('checks update role predicates for implicit old-child removal', async () => {
    await expect(mutate('set', [101], 3, { targetWhere: { id: 101 } })).rejects.toMatchObject({
      code: 'ACCESS_RECORD_UNAVAILABLE',
    });
    expect(await linked()).toEqual([105]);
  });
  it('claims historical source and target only on a successful real change', async () => {
    await configure(mainIdentity, withLegacy);
    await configure(childIdentity, withLegacy);
    await mutate('add', [104], 5);
    expect((await parent(5)).getDataValue('tenantId')).toBe('B');
    expect((await child(104)).getDataValue('tenantId')).toBe('B');
    expect((await child(104)).getDataValue('documentId')).toBe(5);
  });
  it('does not claim unchanged historical source or target records', async () => {
    await configure(mainIdentity, withLegacy);
    await children.model.update({ documentId: 5 }, { where: { id: 104 } });
    expect(await mutate('set', [104], 5)).toEqual({ keys: [], affected: 0 });
    expect((await parent(5)).getDataValue('tenantId')).toBeNull();
    expect((await child(104)).getDataValue('tenantId')).toBeNull();
  });
  it('claims an implicitly detached historical child when G permits its edit', async () => {
    await configure(childIdentity, withLegacy);
    await children.model.update({ documentId: 3 }, { where: { id: 104 } });
    await mutate('set', [105]);
    expect((await child(104)).getDataValue('tenantId')).toBe('B');
    expect((await child(104)).getDataValue('documentId')).toBeNull();
  });
  it('reports visible historical children as read-only if only V matches', async () => {
    await expect(mutate('add', [104])).rejects.toMatchObject({ code: 'LEGACY_DATA_READ_ONLY' });
    expect((await child(104)).getDataValue('tenantId')).toBeNull();
  });
  it('authorizes the old child state and allows a successful edit to leave G', async () => {
    await configure(childIdentity, { type: 'isNull', operand: { type: 'field', path: 'documentId' } });
    await mutate('add', [101]);
    expect((await child(101)).getDataValue('documentId')).toBe(3);
  });
  it('deduplicates targets and does not write or notify for a no-op', async () => {
    const hook = vi.fn();
    children.model.addHook('beforeUpdate', hook);
    expect(await mutate('add', [105, 105])).toEqual({ keys: [], affected: 0 });
    expect(await mutate('remove', [101])).toEqual({ keys: [], affected: 0 });
    expect(hook).not.toHaveBeenCalled();
  });
  it('keeps separately named role SQL bindings', async () => {
    const result = await mutate('add', [101], 3, {
      sourceWhere: literal('"documents"."id" = $key'),
      sourceBind: { key: 3 },
      targetWhere: literal('"children"."id" = $key'),
      targetBind: { key: 101 },
    });
    expect(result.affected).toBe(1);
  });
  it.each(['values', 'throughValues', 'sort'])('rejects unsupported input %s', async (key) => {
    await expect(mutate('add', [101], 3, { [key]: {} })).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await linked()).toEqual([105]);
  });
  it('rejects invalid batches operation keys and foreign identities', async () => {
    for (const extra of [
      { sourceKey: '_' },
      { operation: 'destroy' },
      { targetKeys: [NaN] },
      { targetKeys: Array.from({ length: 1001 }, () => 101) },
    ])
      await expect(mutate('add', [101], 3, extra)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    await expect(
      service.withChildren(ctx, mainIdentity, { ...childIdentity, dataSourceKey: 'external' }, authenticated, {
        association: 'children',
        operation: 'add',
        sourceKey: 3,
        targetKeys: [101],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });
  it('rejects unprepared configurations and a phase released before writing', async () => {
    adapter.release(ctx);
    await expect(mutate('add', [101])).rejects.toMatchObject({ code: 'INVALID_ACCESS_CONFIG_WRITE' });
    expect(await linked()).toEqual([105]);
  });
  it('rejects a write that tries to gain G by changing the parent', async () => {
    await configure(childIdentity, {
      type: 'compare',
      operator: 'eq',
      left: { type: 'field', path: 'documentId' },
      right: { type: 'literal', value: 3 },
    });
    await expect(mutate('add', [101])).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect((await child(101)).getDataValue('documentId')).toBeNull();
  });
  it('rejects a hook expanding the target repository selection to other children', async () => {
    children.model.addHook('beforeFind', 'widen', (options) => {
      options.where = {};
    });
    await expect(mutate('add', [101])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    children.model.removeHook('beforeFind', 'widen');
    expect(await linked()).toEqual([105]);
    expect((await child(103)).getDataValue('documentId')).toBeNull();
  });

  it.each(['beforeUpdate', 'afterUpdate'])(
    'rejects nested target writes issued by %s even with hooks disabled',
    async (hook) => {
      children.model.addHook(hook, async (_record, options) => {
        await children.model.update(
          { documentId: 3 },
          { where: { id: 103 }, transaction: options.transaction, hooks: false },
        );
      });
      await expect(mutate('add', [101])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(await linked()).toEqual([105]);
      expect((await child(103)).getDataValue('documentId')).toBeNull();
      expect(db.sequelize.hasHook('beforeQuery')).toBe(false);
    },
  );

  it('rejects a hook replacing the actual update transaction before SQL executes', async () => {
    children.model.addHook('beforeUpdate', (_record, options) => {
      options.transaction = null;
    });
    await expect(mutate('add', [101])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect((await child(101)).getDataValue('documentId')).toBeNull();
    expect(db.sequelize.hasHook('beforeQuery')).toBe(false);
  });

  it('rolls back a wrong child foreign key and pending commit notifications', async () => {
    const notify = vi.fn();
    children.model.addHook('beforeUpdate', (record, options) => {
      record.setDataValue('documentId', 4);
      options.transaction.afterCommit(notify);
    });
    await expect(mutate('add', [101])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect((await child(101)).getDataValue('documentId')).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  it('rolls back a forbidden child ownership change', async () => {
    children.model.addHook('beforeUpdate', (record) => record.setDataValue('tenantId', 'C'));
    await expect(mutate('add', [101])).rejects.toMatchObject({ code: 'ACCESS_OWNERSHIP_CHANGE_FORBIDDEN' });
    expect((await child(101)).getDataValue('tenantId')).toBe('B');
    expect((await child(101)).getDataValue('documentId')).toBeNull();
  });

  it('rolls back source and target claims if a later child update fails', async () => {
    await configure(mainIdentity, withLegacy);
    await configure(childIdentity, withLegacy);
    const original = new Error('business child failure');
    children.model.addHook('beforeUpdate', () => {
      throw original;
    });
    await expect(mutate('add', [104], 5)).rejects.toBe(original);
    expect((await parent(5)).getDataValue('tenantId')).toBeNull();
    expect((await child(104)).getDataValue('tenantId')).toBeNull();
  });

  it('publishes one notification per actual child edit only after successful commit', async () => {
    const notify = vi.fn();
    children.model.addHook('afterUpdate', (_record, options) => options.transaction.afterCommit(notify));
    await mutate('add', [101]);
    await mutate('add', [101]);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('rejects non-HasMany associations and ownership foreign keys', async () => {
    await expect(mutate('add', [101], 3, { association: 'missing' })).rejects.toMatchObject({
      code: 'INVALID_ACCESS_MUTATION',
    });
    const relation = docs.model.associations.children as typeof docs.model.associations.children & {
      foreignKey: string;
    };
    relation.foreignKey = 'tenantId';
    await expect(mutate('add', [101])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });

  it('rejects scoped and non-primary-source-key associations', async () => {
    const relation = docs.model.associations.children as typeof docs.model.associations.children & {
      sourceKey: string;
      scope?: object;
    };
    relation.scope = { name: 'Owned' };
    await expect(mutate('add', [101])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    delete relation.scope;
    relation.sourceKey = 'name';
    await expect(mutate('add', [101])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await linked()).toEqual([105]);
  });

  it('rejects a target foreign key also used as the referenced key of another relation', async () => {
    children.model.hasMany(docs.model, {
      as: 'indirect',
      foreignKey: 'name',
      sourceKey: 'documentId',
      constraints: false,
    });
    await expect(mutate('add', [101])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await linked()).toEqual([105]);
  });

  it('rolls back when a business hook replaces the relation metadata', async () => {
    children.model.addHook('beforeUpdate', () => {
      docs.model.associations.children = {
        ...docs.model.associations.children,
      } as typeof docs.model.associations.children;
    });
    await expect(mutate('add', [101])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect((await child(101)).getDataValue('documentId')).toBeNull();
  });

  it('rejects a phase released during source authorization before writing', async () => {
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementation(async (...args) => {
      const result = await original(...args);
      adapter.release(ctx);
      return result;
    });
    await expect(mutate('add', [101])).rejects.toMatchObject({ code: 'INVALID_ACCESS_CONFIG_WRITE' });
    expect((await child(101)).getDataValue('documentId')).toBeNull();
  });

  it('preserves target default scopes instead of editing a hidden target', async () => {
    children.model.addScope('defaultScope', { where: { id: 105 } }, { override: true });
    await expect(mutate('add', [101])).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect((await children.model.unscoped().findByPk(101)).getDataValue('documentId')).toBeNull();
  });

  it('respects non-null child foreign keys and rolls back earlier edits in the replacement', async () => {
    await children.model.update({ documentId: 4 }, { where: { documentId: null } });
    children.model.rawAttributes.documentId.allowNull = false;
    children.model.refreshAttributes();
    await children.model.sync({ alter: true });
    await expect(mutate('set', [101])).rejects.toThrow();
    expect((await child(101)).getDataValue('documentId')).toBe(4);
    expect((await child(105)).getDataValue('documentId')).toBe(3);
  });

  it('rejects an excessively large implicit replacement before invoking any writer', async () => {
    await children.model.bulkCreate(
      Array.from({ length: 1000 }, (_, i) => ({ id: i + 1000, tenantId: 'B', documentId: 3 })),
    );
    const write = vi.fn();
    children.model.addHook('beforeUpdate', write);
    await expect(mutate('set', [])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(write).not.toHaveBeenCalled();
    expect(await children.model.count({ where: { documentId: 3 } })).toBe(1001);
  });

  it('does not require tenant context or claim records for an explicitly shared model', async () => {
    for (const identity of [mainIdentity, childIdentity]) {
      await store.save(
        identity,
        {
          ...configFor({ type: 'constant', value: true }),
          ownership: { enabled: false },
          revision: (await store.read(identity))!.revision,
        },
        { userId: 28 },
      );
    }
    adapter.release(ctx);
    await adapter.prepare(ctx, [mainIdentity, childIdentity]);
    const result = await service.withChildren(
      ctx,
      mainIdentity,
      childIdentity,
      {},
      { association: 'children', operation: 'add', sourceKey: 5, targetKeys: [104] },
    );
    expect(result.affected).toBe(1);
    expect((await parent(5)).getDataValue('tenantId')).toBeNull();
    expect((await child(104)).getDataValue('tenantId')).toBeNull();
  });

  it('serializes competing parents binding the same child without exposing database deadlocks', async () => {
    await docs.repository.create({ values: { id: 6, tenantId: 'B', name: 'Other owned' } });
    const references = new AccessReferenceService(db, adapter, queries);
    const authorize = references.authorizeTargets.bind(references);
    let arrivals = 0;
    let release!: () => void;
    const rendezvous = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(references, 'authorizeTargets').mockImplementation(async (...args) => {
      const result = await authorize(...args);
      if (++arrivals === 2) release();
      // SHARE-first locking lets both arrive. UPDATE-first locking serializes them,
      // so bound the rendezvous rather than holding the winner indefinitely.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([rendezvous, new Promise<void>((resolve) => (timer = setTimeout(resolve, 1000)))]);
      } finally {
        clearTimeout(timer);
      }
      return result;
    });
    const concurrent = new AccessHasManyService(
      db,
      adapter,
      queries,
      new AccessMutationService(db, adapter, queries),
      references,
    );
    const notify = vi.fn();
    const write = vi.fn((_record, options) => options.transaction.afterCommit(notify));
    children.model.addHook('afterUpdate', write);
    const results = await Promise.allSettled(
      [3, 6].map((sourceKey) =>
        concurrent.withChildren(ctx, mainIdentity, childIdentity, authenticated, {
          association: 'children',
          operation: 'add',
          sourceKey,
          targetKeys: [101],
        }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: 'ACCESS_MUTATION_CONFLICT', status: 409 });
    expect([3, 6]).toContain((await child(101)).getDataValue('documentId'));
    expect(write).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('rejects a concurrent child revocation without invoking or retrying its writer', async () => {
    const original = queries.scopeQuery.bind(queries);
    let changed = false;
    const write = vi.fn();
    children.model.addHook('beforeUpdate', write);
    vi.spyOn(queries, 'scopeQuery').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[1].collectionName === 'documents' && !changed) {
        changed = true;
        await children.model.update({ tenantId: 'C' }, { where: { id: 101 } });
      }
      return result;
    });
    await expect(mutate('add', [101])).rejects.toMatchObject({ code: 'ACCESS_MUTATION_CONFLICT', status: 409 });
    expect(write).not.toHaveBeenCalled();
    expect((await child(101)).getDataValue('tenantId')).toBe('C');
    expect((await child(101)).getDataValue('documentId')).toBeNull();
  });

  it('rolls back relational G write skew without retrying writes or sending commit notifications', async () => {
    const readers = db.collection({
      name: 'readers',
      tableName: 'hm_readers',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'childId', type: 'integer' },
        { name: 'canEdit', type: 'boolean' },
      ],
    });
    children.setField('readers', { type: 'hasMany', target: 'readers', foreignKey: 'childId' });
    await readers.model.sync();
    await readers.repository.create({ values: { id: 1, childId: 101, canEdit: true } });
    await configure(childIdentity, {
      type: 'exists',
      path: 'readers',
      condition: {
        type: 'compare',
        operator: 'eq',
        left: { type: 'field', path: 'canEdit' },
        right: { type: 'literal', value: true },
      },
    });
    const notify = vi.fn();
    const write = vi.fn(async (_record, options) => {
      options.transaction.afterCommit(notify);
      await db.sequelize.transaction(
        { isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE },
        async (transaction) => {
          expect((await children.model.findByPk(101, { transaction })).getDataValue('documentId')).toBeNull();
          await readers.model.update({ canEdit: false }, { where: { id: 1 }, transaction });
        },
      );
    });
    children.model.addHook('beforeUpdate', write);
    await expect(mutate('add', [101])).rejects.toMatchObject({ code: 'ACCESS_MUTATION_CONFLICT', status: 409 });
    expect(write).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect((await child(101)).getDataValue('documentId')).toBeNull();
    expect((await readers.model.findByPk(1)).getDataValue('canEdit')).toBe(false);
  });
});

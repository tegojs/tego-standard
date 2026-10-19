import { ACL, Resourcer, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { AccessTargetForeignKeyMutationHandler } from '../../access-control/has-many-mutation-handler';
import { AccessHasOneService } from '../../access-control/has-one';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessMutationService } from '../../access-control/mutation';
import { AccessQueryService } from '../../access-control/query';
import { AccessReferenceService } from '../../access-control/references';
import type { AccessCondition } from '../../access-control/types';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const target = { dataSourceKey: 'main', collectionKey: 'profiles-key', collectionName: 'profiles' };
const authenticated = { tenantId: 'B' };

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('access has-one (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let profiles: Collection;
  let store: AccessConfigStore;
  let adapter: AccessAclScopeAdapter;
  let queries: AccessQueryService;
  let service: AccessHasOneService;
  let handler: AccessTargetForeignKeyMutationHandler;
  let ctx: object;
  const stableKey = (collection: Collection) =>
    accessCollectionKey({ ...mainIdentity, collectionKey: `${collection.name}-key`, collectionName: collection.name });
  const identity = (collection: Collection) => (collection === docs ? mainIdentity : target);

  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl) : sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    const fields = [
      { name: 'id', type: 'integer', primaryKey: true },
      { name: 'tenantId', type: 'string' },
      { name: 'name', type: 'string' },
    ];
    docs = db.collection({ name: 'documents', tableName: 'ho_documents', timestamps: false, fields });
    profiles = db.collection({
      name: 'profiles',
      tableName: 'ho_profiles',
      timestamps: false,
      fields: [...fields, { name: 'documentId', type: 'integer', field: 'document_id' }],
    });
    docs.setField('profile', { type: 'hasOne', target: 'profiles', foreignKey: 'documentId' });
    profiles.setField('document', { type: 'belongsTo', target: 'documents', foreignKey: 'documentId' });
    const tenants = db.collection({
      name: 'tenants',
      tableName: 'ho_tenants',
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
        { id: 6, tenantId: 'B', name: 'Other owned' },
      ],
    });
    await profiles.repository.create({
      values: [
        { id: 101, tenantId: 'B', name: 'Owned', documentId: null },
        { id: 102, tenantId: 'H', name: 'Shared', documentId: null },
        { id: 103, tenantId: 'C', name: 'Hidden', documentId: null },
        { id: 104, tenantId: null, name: 'Legacy', documentId: null },
        { id: 105, tenantId: 'B', name: 'Owned', documentId: 3 },
        { id: 106, tenantId: 'B', name: 'Owned', documentId: 4 },
      ],
    });
    await db.getRepository('collections').create({ values: { key: 'profiles-key', name: 'profiles' } });
    store = new AccessConfigStore(db, (identity) =>
      resolveModelMetadata(db.getCollection(identity.collectionName), { resolveCollectionKey: stableKey }),
    );
    const config = {
      ...configFor(ownerCondition),
      revision: 0,
      rules: [
        ...configFor(ownerCondition).rules,
        { ...configFor({ type: 'constant', value: true }, 'visibility').rules[0], id: 'read-all' },
      ],
    };
    await store.save(mainIdentity, config, { userId: 28 });
    await store.save(target, config, { userId: 28 });
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    queries = new AccessQueryService(db, adapter, stableKey);
    service = new AccessHasOneService(
      db,
      adapter,
      queries,
      new AccessMutationService(db, adapter, queries),
      new AccessReferenceService(db, adapter, queries),
    );
    handler = new AccessTargetForeignKeyMutationHandler(db, adapter, queries, identity, 'HasOne');
    ctx = {};
    await adapter.prepare(ctx, [mainIdentity, target]);
  });

  afterEach(async () => {
    try {
      if (dialect === 'postgres')
        await db.sequelize.query(
          'DROP TABLE IF EXISTS "rolesResourcesScopesActions", "dataSourcesRolesResourcesScopesActions", ' +
            '"rolesResourcesScopes", "dataSourcesRolesResourcesScopes", "access_config_collections", ' +
            '"access_config_dataSourcesCollections", "tenantAccessRevisions", "ho_profiles", "ho_documents", "ho_tenants"',
        );
    } finally {
      await db.close();
    }
  });

  const mutate = (targetKey: number | null, sourceKey = 3, extra = {}) =>
    service.withTarget(ctx, mainIdentity, target, authenticated, {
      association: 'profile',
      sourceKey,
      targetKey,
      ...extra,
    });
  const profile = (id: number) => profiles.model.findByPk(id);
  const parent = (id: number) => docs.model.findByPk(id);
  const linked = async (sourceKey = 3) =>
    (await profiles.model.findAll({ where: { documentId: sourceKey }, order: [['id', 'ASC']] })).map((row) =>
      row.getDataValue('id'),
    );
  async function configure(identity: typeof mainIdentity, condition: AccessCondition) {
    const previous = (await store.read(identity))!;
    await store.save(
      identity,
      {
        ...previous,
        rules: [
          { ...configFor(condition).rules[0], id: 'editable' },
          ...previous.rules.filter((r) => r.category === 'visibility'),
        ],
      },
      { userId: 28 },
    );
    adapter.release(ctx);
    await adapter.prepare(ctx, [mainIdentity, target]);
  }
  const withLegacy: AccessCondition = {
    type: 'any',
    children: [ownerCondition, { type: 'isNull', operand: { type: 'field', path: 'tenantId' } }],
  };

  async function actionContext(
    resourceName: string,
    actionName: string,
    params: object = {},
    grant: object = {},
    source?: string,
  ) {
    const acl = new ACL();
    for (const action of ['add', 'remove', 'set', 'update', 'list']) acl.setAvailableAction(action, {});
    acl.define({ role: 'editor' }).grantAction(`${resourceName}:${actionName}`, grant);
    const resourcer = new Resourcer();
    resourcer.define({ name: resourceName, actions: { add: {}, remove: {}, set: {}, update: {}, list: {} } });
    const action = resourcer.getAction(resourceName, actionName).clone();
    Object.assign(action, {
      resourceName: source === undefined ? resourceName : 'documents.profile',
      actionName,
      sourceId: source,
      resourceOf: source,
    });
    action.mergeParams({
      resourceName: source === undefined ? resourceName : 'profile',
      actionName,
      filterByTk: undefined,
      ...(source === undefined ? {} : { associatedName: 'documents', associatedIndex: source }),
      ...params,
    });
    const context = {
      db,
      action,
      permission: undefined as unknown,
      body: 'unchanged' as unknown,
      state: { currentRole: 'editor', currentUser: { id: 28, name: 'Owned' } },
      get: () => '+08:00',
      getCurrentRepository: () =>
        source === undefined ? undefined : { targetCollection: db.getCollection(resourceName) },
      logger: { info: vi.fn() },
      throw: (status: number) => {
        throw new Error(String(status));
      },
    };
    await adapter.prepare(context, [mainIdentity, target]);
    await acl.middleware()(context as never, async () => {});
    return context;
  }

  const associationAction = (operation: 'set' | 'remove', params: object = {}, grant: object = {}) =>
    actionContext('profiles', operation, params, grant, '3');

  const handleAssociation = async (
    context: Awaited<ReturnType<typeof actionContext>>,
    sourceGrant: object = {},
    updateGrant: object = { fields: ['document'] },
    readGrant: object = { fields: ['id'] },
    authorizeRead = async () => actionContext('profiles', 'list', {}, readGrant),
    authorizeUpdate = async () => actionContext('profiles', 'update', {}, updateGrant),
  ) =>
    handler.handle(
      context as never,
      { ...authenticated, roleName: 'editor', userId: 28 },
      async (_collection, operation) => actionContext('documents', operation, {}, sourceGrant),
      authorizeUpdate,
      authorizeRead,
    );

  it('resolves association action permissions against the target collection', async () => {
    const context = await associationAction('set', { values: 101 }, { fields: ['id'] });

    expect(context.permission).toMatchObject({
      resourceName: 'profiles',
      actionName: 'set',
      can: { resource: 'profiles', action: 'set', role: 'editor' },
      parsedParams: { fields: ['id'] },
    });
  });

  if (dialect === 'sqlite') {
    it('rejects relationship writes on unvalidated dialects', async () => {
      await expect(mutate(101)).rejects.toMatchObject({ code: 'UNSUPPORTED_ACCESS_MUTATION' });
      expect(await linked()).toEqual([105]);
    });
    return;
  }

  it('replaces one target with independent source, target, read, and update grants', async () => {
    const context = await associationAction('set', { values: 101 }, { fields: ['id'] });
    await handleAssociation(context, { fields: ['profile'] });
    expect(await linked()).toEqual([101]);
    expect(context.body).toEqual({ keys: [101, 105], affected: 2 });
  });

  it.each([{}, { values: [] }])('removes the current target without an explicit target selector %j', async (params) => {
    const context = await associationAction('remove', params);
    const authorizeRead = vi.fn(async () => actionContext('profiles', 'list', {}, { fields: ['id'] }));
    await handleAssociation(context, { fields: ['profile'] }, { fields: ['document'] }, {}, authorizeRead);
    expect(await linked()).toEqual([]);
    expect(context.body).toEqual({ keys: [105], affected: 1 });
    expect(authorizeRead).not.toHaveBeenCalled();
  });

  it('does not let remove bypass G for the current target', async () => {
    await profiles.model.update({ tenantId: 'H' }, { where: { id: 105 } });
    const context = await associationAction('remove');
    await expect(handleAssociation(context, { fields: ['profile'] })).rejects.toMatchObject({
      code: 'ACCESS_RECORD_UNAVAILABLE',
    });
    expect(await linked()).toEqual([105]);
  });

  it('requires the target update grant to include its inverse relationship field', async () => {
    const context = await associationAction('remove');
    await expect(handleAssociation(context, { fields: ['profile'] }, { fields: ['name'] })).rejects.toMatchObject({
      code: 'INVALID_ACCESS_MUTATION',
    });
    expect(await linked()).toEqual([105]);
  });

  it('rejects relationship metadata changes during asynchronous update authorization', async () => {
    const context = await associationAction('remove');
    const authorizeUpdate = async () => {
      const decision = await actionContext('profiles', 'update', {}, { fields: ['document'] });
      profiles.removeField('document');
      return decision;
    };

    await expect(
      handleAssociation(
        context,
        { fields: ['profile'] },
        { fields: ['document'] },
        { fields: ['id'] },
        undefined,
        authorizeUpdate,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await linked()).toEqual([105]);
  });

  it('intersects target remove and independent update role conditions', async () => {
    const context = await associationAction('remove', {}, { filter: { id: 101 } });
    await expect(handleAssociation(context, { fields: ['profile'] })).rejects.toMatchObject({
      code: 'ACCESS_RECORD_UNAVAILABLE',
    });
    const unrestricted = await associationAction('remove');
    await expect(
      handleAssociation(unrestricted, { fields: ['profile'] }, { fields: ['document'], filter: { id: 101 } }),
    ).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await linked()).toEqual([105]);
  });

  it('replaces and clears a single target without transferring ownership', async () => {
    expect(await mutate(101)).toEqual({ keys: [101, 105], affected: 2 });
    expect(await linked()).toEqual([101]);
    expect((await profile(105)).getDataValue('documentId')).toBeNull();
    expect((await profile(101)).getDataValue('tenantId')).toBe('B');
    expect(await mutate(null)).toEqual({ keys: [101], affected: 1 });
    expect(await linked()).toEqual([]);
  });

  it('binds an empty source and can move a writable target from another source', async () => {
    expect(await mutate(101, 6)).toEqual({ keys: [101], affected: 1 });
    expect(await mutate(106)).toEqual({ keys: [105, 106], affected: 2 });
    expect(await linked()).toEqual([106]);
    expect(await linked(4)).toEqual([]);
    expect((await parent(4)).getDataValue('tenantId')).toBe('C');
  });

  it.each([1, 4])('rejects a visibility-only source %s before changing targets', async (sourceKey) => {
    await expect(mutate(101, sourceKey)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await linked()).toEqual([105]);
    expect((await profile(101)).getDataValue('documentId')).toBeNull();
  });

  it.each([102, 103, 999])('rejects a non-writable or missing new target %s', async (targetKey) => {
    await expect(mutate(targetKey)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await linked()).toEqual([105]);
  });

  it('checks G for the implicitly detached old target before writing the new one', async () => {
    await profiles.model.update({ tenantId: 'H' }, { where: { id: 105 } });
    const write = vi.fn();
    profiles.model.addHook('beforeUpdate', write);
    await expect(mutate(101)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(write).not.toHaveBeenCalled();
    expect(await linked()).toEqual([105]);
    expect((await profile(101)).getDataValue('documentId')).toBeNull();
  });

  it('rejects a hidden old target without exposing or silently removing it', async () => {
    const config = (await store.read(target))!;
    await store.save(
      target,
      { ...config, rules: config.rules.filter((r) => r.category === 'ownership') },
      { userId: 28 },
    );
    adapter.release(ctx);
    await adapter.prepare(ctx, [mainIdentity, target]);
    await profiles.model.update({ tenantId: 'C' }, { where: { id: 105 } });
    await expect(mutate(null)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await linked()).toEqual([105]);
  });

  it.each([
    { sourceWhere: { id: 6 } },
    { targetReadWhere: { id: 105 } },
    { targetWhere: { id: 101 } },
    { targetWhere: { id: 105 } },
  ])('intersects separate source read and actual target update predicates %j', async (extra) => {
    await expect(mutate(101, 3, extra)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await linked()).toEqual([105]);
  });

  it('does not turn an unchanged visibility-only target into an edit', async () => {
    await profiles.model.update({ tenantId: 'H' }, { where: { id: 105 } });
    const write = vi.fn();
    profiles.model.addHook('beforeUpdate', write);
    expect(await mutate(105, 3, { targetWhere: { id: 101 } })).toEqual({ keys: [], affected: 0 });
    await expect(mutate(105, 3, { targetReadWhere: { id: 101 } })).rejects.toMatchObject({
      code: 'ACCESS_RECORD_UNAVAILABLE',
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('does not write or notify when clearing an empty source', async () => {
    const write = vi.fn();
    profiles.model.addHook('afterUpdate', write);
    expect(await mutate(null, 6)).toEqual({ keys: [], affected: 0 });
    expect(write).not.toHaveBeenCalled();
  });

  it('claims historical source and actually detached historical target only on success', async () => {
    await configure(mainIdentity, withLegacy);
    await configure(target, withLegacy);
    await profiles.model.update({ documentId: 5 }, { where: { id: 104 } });
    await mutate(101, 5);
    expect((await parent(5)).getDataValue('tenantId')).toBe('B');
    expect((await profile(104)).getDataValue('tenantId')).toBe('B');
    expect((await profile(104)).getDataValue('documentId')).toBeNull();
    expect((await profile(101)).getDataValue('documentId')).toBe(5);
  });

  it('claims a newly bound historical target but never claims unchanged historical records', async () => {
    await configure(mainIdentity, withLegacy);
    await configure(target, withLegacy);
    await profiles.model.update({ documentId: 5 }, { where: { id: 104 } });
    expect(await mutate(104, 5)).toEqual({ keys: [], affected: 0 });
    expect((await parent(5)).getDataValue('tenantId')).toBeNull();
    expect((await profile(104)).getDataValue('tenantId')).toBeNull();
    await profiles.model.update({ documentId: null }, { where: { id: 104 } });
    await mutate(104, 5);
    expect((await parent(5)).getDataValue('tenantId')).toBe('B');
    expect((await profile(104)).getDataValue('tenantId')).toBe('B');
  });

  it('reports a visible historical old target as read-only and preserves the existing binding', async () => {
    await profiles.model.update({ tenantId: null }, { where: { id: 105 } });
    await expect(mutate(101)).rejects.toMatchObject({ code: 'LEGACY_DATA_READ_ONLY' });
    expect(await linked()).toEqual([105]);
    expect((await profile(105)).getDataValue('tenantId')).toBeNull();
  });

  it('authorizes the old target state and permits a valid change to leave G', async () => {
    await configure(target, {
      type: 'compare',
      operator: 'eq',
      left: { type: 'field', path: 'documentId' },
      right: { type: 'literal', value: 3 },
    });
    expect(await mutate(null)).toEqual({ keys: [105], affected: 1 });
    expect(await linked()).toEqual([]);
    await expect(mutate(105)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
  });

  it('detaches before binding when the child foreign key has a unique constraint', async () => {
    await db.sequelize.query('CREATE UNIQUE INDEX ho_unique_document ON ho_profiles (document_id)');
    const writes: number[] = [];
    profiles.model.addHook('beforeUpdate', (record) => {
      writes.push(record.getDataValue('id'));
    });
    await mutate(101);
    expect(writes).toEqual([105, 101]);
    expect(await linked()).toEqual([101]);
  });

  it('rejects multiple existing HasOne targets without arbitrarily choosing or detaching one', async () => {
    await profiles.model.update({ documentId: 3 }, { where: { id: 101 } });
    const write = vi.fn();
    profiles.model.addHook('beforeUpdate', write);
    await expect(mutate(null)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(write).not.toHaveBeenCalled();
    expect(await linked()).toEqual([101, 105]);
  });

  it('respects a non-null foreign key and rolls back the replacement', async () => {
    await profiles.model.update({ documentId: 4 }, { where: { documentId: null } });
    await db.sequelize.query('ALTER TABLE ho_profiles ALTER COLUMN document_id SET NOT NULL');
    await expect(mutate(null)).rejects.toThrow();
    expect(await linked()).toEqual([105]);
  });

  it.each([
    { targetKey: undefined },
    { targetKey: [101] },
    { targetKey: '_' },
    { targetKeys: [101] },
    { operation: 'add' },
    { values: { name: 'Unexpected' } },
    { transaction: {} },
  ])('rejects unsupported input %j without changing any target', async (extra) => {
    await expect(mutate(101, 3, extra)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await linked()).toEqual([105]);
  });

  it('rejects a HasMany relationship passed to the single-target service', async () => {
    docs.removeField('profile');
    docs.setField('profile', { type: 'hasMany', target: 'profiles', foreignKey: 'documentId' });
    await expect(mutate(101)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });

  it('rejects scoped and cross-data-source relationships', async () => {
    await expect(
      service.withTarget(ctx, mainIdentity, { ...target, dataSourceKey: 'external' }, authenticated, {
        association: 'profile',
        sourceKey: 3,
        targetKey: 101,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    (docs.model.associations.profile as unknown as { scope: object }).scope = { name: 'Owned' };
    await expect(mutate(101)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });

  it('preserves target default scopes instead of editing a hidden target', async () => {
    profiles.model.addScope('defaultScope', { where: { id: 105 } }, { override: true });
    await expect(mutate(101)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect((await profiles.model.unscoped().findByPk(105)).getDataValue('documentId')).toBe(3);
  });

  it('rolls back both sides and pending commit notifications when the new binding fails', async () => {
    const notify = vi.fn();
    profiles.model.addHook('afterUpdate', (_record, options) => {
      options.transaction.afterCommit(notify);
    });
    profiles.model.addHook('beforeUpdate', (record) => {
      if (record.getDataValue('id') === 101) throw new Error('New binding failed');
    });
    await expect(mutate(101)).rejects.toThrow('New binding failed');
    expect(await linked()).toEqual([105]);
    expect((await profile(101)).getDataValue('documentId')).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  it('rolls back historical claims when a later replacement write fails', async () => {
    await configure(mainIdentity, withLegacy);
    await configure(target, withLegacy);
    await profiles.model.update({ documentId: 5 }, { where: { id: 104 } });
    profiles.model.addHook('beforeUpdate', (record) => {
      if (record.getDataValue('id') === 101) throw new Error('New binding failed');
    });
    await expect(mutate(101, 5)).rejects.toThrow('New binding failed');
    expect((await parent(5)).getDataValue('tenantId')).toBeNull();
    expect((await profile(104)).getDataValue('tenantId')).toBeNull();
    expect((await profile(104)).getDataValue('documentId')).toBe(5);
  });

  it('rejects nested target edits in business hooks even with model hooks disabled', async () => {
    profiles.model.addHook('beforeUpdate', async () => {
      await profiles.model.update({ name: 'Unexpected' }, { where: { id: 106 }, hooks: false });
    });
    await expect(mutate(101)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await linked()).toEqual([105]);
    expect((await profile(106)).getDataValue('name')).toBe('Owned');
  });

  it('rolls back ownership changes hidden in a target hook', async () => {
    profiles.model.addHook('beforeUpdate', (record) => {
      record.set('tenantId', 'C');
    });
    await expect(mutate(101)).rejects.toMatchObject({ code: 'ACCESS_OWNERSHIP_CHANGE_FORBIDDEN' });
    expect(await linked()).toEqual([105]);
    expect((await profile(105)).getDataValue('tenantId')).toBe('B');
  });

  it('rolls back if a business hook replaces the registered relationship', async () => {
    const association = docs.model.associations.profile;
    profiles.model.addHook('beforeUpdate', () => {
      docs.model.associations.profile = { ...association } as typeof association;
    });
    await expect(mutate(101)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await linked()).toEqual([105]);
  });

  it('does not require tenant context or claim records for an explicitly shared model', async () => {
    for (const identity of [mainIdentity, target]) {
      const previous = (await store.read(identity))!;
      await store.save(
        identity,
        {
          ...configFor({ type: 'constant', value: true }),
          ownership: { enabled: false },
          revision: previous.revision,
        },
        { userId: 28 },
      );
    }
    adapter.release(ctx);
    await adapter.prepare(ctx, [mainIdentity, target]);
    await service.withTarget(ctx, mainIdentity, target, {}, { association: 'profile', sourceKey: 5, targetKey: 104 });
    expect((await parent(5)).getDataValue('tenantId')).toBeNull();
    expect((await profile(104)).getDataValue('tenantId')).toBeNull();
  });

  it.each(['same source', 'same target'])('serializes competing replacements for the %s', async (scenario) => {
    const mutations = new AccessMutationService(db, adapter, queries);
    const authorize = mutations.authorizeReferenceSource.bind(mutations);
    let arrivals = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(mutations, 'authorizeReferenceSource').mockImplementation(async (...args) => {
      if (args[1].collectionName === 'documents') {
        // Establish both snapshots before either source lock or target write.
        await docs.model.findByPk(args[3].keys[0], { transaction: args[4], hooks: false });
        if (++arrivals === 2) release();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([ready, new Promise<void>((resolve) => (timer = setTimeout(resolve, 1000)))]);
        } finally {
          clearTimeout(timer);
        }
      }
      return authorize(...args);
    });
    const concurrent = new AccessHasOneService(
      db,
      adapter,
      queries,
      mutations,
      new AccessReferenceService(db, adapter, queries),
    );
    const notify = vi.fn();
    const write = vi.fn((_record, options) => {
      options.transaction.afterCommit(notify);
    });
    profiles.model.addHook('afterUpdate', write);
    const inputs =
      scenario === 'same source'
        ? [
            [3, 101],
            [3, 106],
          ]
        : [
            [3, 101],
            [6, 101],
          ];
    const results = await Promise.allSettled(
      inputs.map(([sourceKey, targetKey]) =>
        concurrent.withTarget(ctx, mainIdentity, target, authenticated, {
          association: 'profile',
          sourceKey,
          targetKey,
        }),
      ),
    );
    const successful = results.filter((result) => result.status === 'fulfilled') as PromiseFulfilledResult<{
      affected: number;
    }>[];
    expect(successful).toHaveLength(1);
    const failed = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: 'ACCESS_MUTATION_CONFLICT', status: 409 });
    expect(write).toHaveBeenCalledTimes(successful[0].value.affected);
    expect(notify).toHaveBeenCalledTimes(successful[0].value.affected);
    if (scenario === 'same source') {
      const keys = await linked();
      expect(keys).toHaveLength(1);
      expect([101, 106]).toContain(keys[0]);
    } else expect([3, 6]).toContain((await profile(101)).getDataValue('documentId'));
  });

  it('rejects a concurrent target revocation without invoking its writer', async () => {
    const original = queries.scopeQuery.bind(queries);
    let changed = false;
    vi.spyOn(queries, 'scopeQuery').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[1].collectionName === 'documents' && !changed) {
        changed = true;
        await profiles.model.update({ tenantId: 'C' }, { where: { id: 101 } });
      }
      return result;
    });
    const write = vi.fn();
    profiles.model.addHook('beforeUpdate', write);
    await expect(mutate(101)).rejects.toMatchObject({ code: 'ACCESS_MUTATION_CONFLICT', status: 409 });
    expect(write).not.toHaveBeenCalled();
    expect(await linked()).toEqual([105]);
    expect((await profile(101)).getDataValue('tenantId')).toBe('C');
  });
});

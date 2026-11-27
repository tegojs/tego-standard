import { mockServer, type MockServer } from '@tachybase/test';
import { ACL, Transaction, type Collection } from '@tego/server';

import UsersPlugin from '../../../../../module-user/src/server/server';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { AccessHasManyService } from '../../access-control/has-many';
import { AccessHasOneService } from '../../access-control/has-one';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessMutationService } from '../../access-control/mutation';
import { AccessQueryService } from '../../access-control/query';
import { AccessReferenceService } from '../../access-control/references';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

/** Preauthorized service inputs; actual context fields and PostgreSQL writes, not an ACL entry simulation. */
describe.skipIf(!postgresUrl)('target association writes with framework audit fields', () => {
  let app: MockServer;
  let docs: Collection;
  let children: Collection;
  let profiles: Collection;
  let adapter: AccessAclScopeAdapter;
  let many: AccessHasManyService;
  let one: AccessHasOneService;
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
    await new UsersPlugin(app, { name: 'audit-target-users' }).beforeLoad();
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
    docs = db.collection({ name: 'documents', timestamps: false, createdBy: true, updatedBy: true, fields });
    children = db.collection({
      name: 'children',
      timestamps: false,
      createdBy: true,
      updatedBy: true,
      fields: [...fields, { name: 'document', type: 'belongsTo', target: 'documents', foreignKey: 'documentId' }],
    });
    profiles = db.collection({
      name: 'profiles',
      timestamps: false,
      createdBy: true,
      updatedBy: true,
      fields: [
        ...fields,
        { name: 'documentId', type: 'integer', unique: true },
        { name: 'document', type: 'belongsTo', target: 'documents', foreignKey: 'documentId' },
      ],
    });
    docs.setField('children', { type: 'hasMany', target: children.name, foreignKey: 'documentId' });
    docs.setField('profile', { type: 'hasOne', target: profiles.name, foreignKey: 'documentId' });
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
    for (const collection of [children, profiles])
      await db.getRepository('collections').create({
        values: {
          name: collection.name,
          key: identity(collection).collectionKey,
        },
      });
    const previous = { state: { currentUser: { id: 29 } } };
    for (const values of [
      { id: 1, name: 'Before', tenantId: 'B' },
      { id: 2, name: 'Legacy source', tenantId: null },
    ])
      await docs.repository.create({ values, context: previous });
    for (const values of [
      { id: 101, name: 'Owned', tenantId: 'B', documentId: 1 },
      { id: 102, name: 'Read-only', tenantId: 'H', documentId: 1 },
      { id: 103, name: 'Legacy new', tenantId: null, documentId: null },
      { id: 104, name: 'Legacy unchanged', tenantId: null, documentId: 1 },
      { id: 105, name: 'Legacy no-op', tenantId: null, documentId: 2 },
    ])
      await children.repository.create({ values, context: previous });
    for (const values of [
      { id: 201, name: 'Owned', tenantId: 'B', documentId: 1 },
      { id: 202, name: 'Read-only', tenantId: 'H', documentId: null },
      { id: 203, name: 'Legacy new', tenantId: null, documentId: null },
      { id: 204, name: 'Legacy no-op', tenantId: null, documentId: 2 },
    ])
      await profiles.repository.create({ values, context: previous });
    const store = new AccessConfigStore(db, (value) =>
      resolveModelMetadata(db.getCollection(value.collectionName), {
        resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
      }),
    );
    for (const collection of [docs, children, profiles]) {
      const config = configFor({
        type: 'any',
        children: [ownerCondition, { type: 'isNull', operand: { type: 'field', path: 'tenantId' } }],
      });
      config.rules.push({ ...configFor({ type: 'constant', value: true }, 'visibility').rules[0], id: 'readable' });
      await store.save(identity(collection), { ...config, revision: 0 }, { userId: 28 });
    }
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    const queries = new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection)));
    const mutations = new AccessMutationService(db, adapter, queries);
    const references = new AccessReferenceService(db, adapter, queries);
    many = new AccessHasManyService(db, adapter, queries, mutations, references);
    one = new AccessHasOneService(db, adapter, queries, mutations, references);
    await adapter.prepare(ctx, [docs, children, profiles].map(identity));
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
  const entry = (afterPersist: (() => Promise<void>) | false = async () => {}) => ({
    assertCurrent: () => {},
    targetReadScope: async () => ({}),
    targetWriteScope: async () => ({}),
    ...(afterPersist === false ? {} : { afterPersist }),
  });
  const bindChildren = (
    operation: 'add' | 'remove' | 'set',
    keys: number[],
    options: { source?: number; values?: object; afterPersist?: () => Promise<void>; lifecycle?: boolean } = {},
  ) =>
    many.withChildren(
      ctx,
      mainIdentity,
      identity(children),
      actor,
      {
        association: 'children',
        operation,
        sourceKey: options.source ?? 1,
        targetKeys: keys,
        ...(options.values ? { sourceValues: options.values } : {}),
      },
      entry(options.lifecycle === false ? false : options.afterPersist),
    );
  const bindProfile = (key: number, source = 1, values?: object) =>
    one.withTarget(
      ctx,
      mainIdentity,
      identity(profiles),
      actor,
      { association: 'profile', sourceKey: source, targetKey: key, ...(values ? { sourceValues: values } : {}) },
      entry(),
    );
  const row = async (collection: Collection, id: number) => (await collection.model.findByPk(id))!.get();

  it('claims only a changed legacy child and maintains source and target audit identities', async () => {
    expect(await bindChildren('add', [103], { values: { name: 'After' } })).toMatchObject({ affected: 1 });
    expect(await row(docs, 1)).toMatchObject({ name: 'After', createdById: 29, updatedById: 28 });
    expect(await row(children, 103)).toMatchObject({ documentId: 1, tenantId: 'B', createdById: 29, updatedById: 28 });
    expect(await row(children, 104)).toMatchObject({ documentId: 1, tenantId: null, updatedById: 29 });
    expect(await row(children, 102)).toMatchObject({ tenantId: 'H', updatedById: 29 });
  });
  it('maintains the native modifier when unlinking an owned child', async () => {
    await bindChildren('remove', [101]);
    expect(await row(children, 101)).toMatchObject({
      documentId: null,
      tenantId: 'B',
      createdById: 29,
      updatedById: 28,
    });
    expect(await row(docs, 1)).toMatchObject({ createdById: 29, updatedById: 28 });
  });
  it('replaces a unique single child while retaining both creators', async () => {
    expect(await bindProfile(203, 1, { name: 'After' })).toMatchObject({ affected: 2 });
    expect(await row(profiles, 201)).toMatchObject({
      documentId: null,
      tenantId: 'B',
      createdById: 29,
      updatedById: 28,
    });
    expect(await row(profiles, 203)).toMatchObject({ documentId: 1, tenantId: 'B', createdById: 29, updatedById: 28 });
    expect(await row(docs, 1)).toMatchObject({ name: 'After', createdById: 29, updatedById: 28 });
  });
  it('keeps unchanged legacy sources and children unclaimed and unaudited', async () => {
    expect(await bindChildren('add', [105], { source: 2 })).toMatchObject({ affected: 0 });
    expect(await bindProfile(204, 2)).toMatchObject({ affected: 0 });
    for (const [collection, id] of [
      [docs, 2],
      [children, 105],
      [profiles, 204],
    ] as const)
      expect(await row(collection, id)).toMatchObject({ tenantId: null, createdById: 29, updatedById: 29 });
  });
  it('cannot unlink a child using only V even though its source is writable', async () => {
    await expect(bindChildren('remove', [102])).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await row(children, 102)).toMatchObject({ documentId: 1, tenantId: 'H', updatedById: 29 });
    expect(await row(docs, 1)).toMatchObject({ name: 'Before', updatedById: 29 });
  });
  it('cannot replace a single child with a V-only target', async () => {
    await expect(bindProfile(202)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await row(profiles, 201)).toMatchObject({ documentId: 1, updatedById: 29 });
    expect(await row(profiles, 202)).toMatchObject({ documentId: null, tenantId: 'H', updatedById: 29 });
  });
  it.each(['children', 'profile'])('rolls back a target hook forging the creator in %s', async (kind) => {
    const collection = kind === 'children' ? children : profiles;
    let persisted = false;
    collection.model.addHook('beforeUpdate', 'forge-target-creator', (record, options) => {
      record.setDataValue('createdById', 30);
      options.fields = [...new Set([...(options.fields ?? Object.keys(record.dataValues)), 'createdById'])];
    });
    collection.model.addHook('afterUpdate', 'observe-forged-creator', async (record, options) => {
      const actual = await collection.model
        .unscoped()
        .findByPk(record.get('id'), { transaction: options.transaction, hooks: false });
      persisted = actual?.getDataValue('createdById') === 30;
    });
    await expect(kind === 'children' ? bindChildren('add', [103]) : bindProfile(203)).rejects.toMatchObject({
      code: 'INVALID_ACCESS_MUTATION',
    });
    expect(persisted).toBe(true);
    expect(await row(docs, 1)).toMatchObject({ name: 'Before', createdById: 29, updatedById: 29 });
    expect(await row(collection, kind === 'children' ? 103 : 203)).toMatchObject({
      documentId: null,
      tenantId: null,
      createdById: 29,
      updatedById: 29,
    });
  });
  it('keeps the post-write stage strict for untouched read-only siblings', async () => {
    let transaction: Transaction | undefined;
    let staged = false;
    docs.model.addHook('afterUpdate', 'observe-stage-transaction', (_record, options) => {
      transaction = options.transaction;
    });
    await expect(
      bindChildren('add', [103], {
        afterPersist: async () => {
          expect(transaction).toBeInstanceOf(Transaction);
          await children.model.update({ updatedById: 28 }, { where: { id: 102 }, transaction, hooks: false });
          staged = true;
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(staged).toBe(true);
    expect(await row(children, 103)).toMatchObject({ documentId: null, tenantId: null, updatedById: 29 });
    expect(await row(children, 102)).toMatchObject({ documentId: 1, tenantId: 'H', updatedById: 29 });
  });
  it.each(['source', 'target'])('checks %s audit columns before reading without a lifecycle callback', async (side) => {
    const collection = side === 'source' ? docs : children;
    const attribute = collection.model.rawAttributes.updatedById;
    const original = attribute.field;
    let forged = false;
    let restored = false;
    collection.model.addHook('beforeUpdate', 'forge-modifier', (record, options) => {
      record.setDataValue('updatedById', 30);
      options.fields = [...new Set([...(options.fields ?? Object.keys(record.dataValues)), 'updatedById'])];
    });
    collection.model.addHook('afterUpdate', 'hide-modifier', () => {
      attribute.field = collection.model.rawAttributes.createdById.field;
      forged = true;
    });
    app.db.sequelize.addHook('afterQuery', 'restore-audit-field', (options) => {
      if (
        forged &&
        options.type === 'SELECT' &&
        (options as { model?: typeof collection.model }).model?.name === collection.model.name
      ) {
        attribute.field = original;
        restored = true;
      }
    });
    let failure: unknown;
    try {
      await bindChildren('add', [103], { lifecycle: false, values: { name: 'After' } });
    } catch (error) {
      failure = error;
    } finally {
      attribute.field = original;
    }
    expect(forged).toBe(true);
    expect(restored).toBe(false);
    expect(failure).toMatchObject({
      code: 'INVALID_ACCESS_MUTATION',
    });
    expect(await row(docs, 1)).toMatchObject({ name: 'Before', updatedById: 29 });
    expect(await row(children, 103)).toMatchObject({ documentId: null, tenantId: null, updatedById: 29 });
  });
});

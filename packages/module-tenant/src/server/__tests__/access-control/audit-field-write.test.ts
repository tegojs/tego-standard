import { mockServer, type MockServer } from '@tachybase/test';
import { ACL, type Collection } from '@tego/server';

import UsersPlugin from '../../../../../module-user/src/server/server';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { AccessCreationService } from '../../access-control/creation';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessMutationService } from '../../access-control/mutation';
import { AccessQueryService } from '../../access-control/query';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])(
  'access writes with framework user audit fields (%s)',
  (dialect) => {
    let app: MockServer;
    let docs: Collection;
    let adapter: AccessAclScopeAdapter;
    let queries: AccessQueryService;
    let store: AccessConfigStore;
    let ctx: { state: { currentUser?: { id: number } } };
    const actor = { tenantId: 'B', userId: 28, roleName: 'editor' };
    const identity = (collection: Collection) =>
      collection === docs
        ? mainIdentity
        : {
            ...mainIdentity,
            collectionName: collection.name,
            collectionKey: `${collection.name}-key`,
          };
    beforeEach(async () => {
      const isolated = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : undefined;
      const database = isolated ? { ...isolated.options } : { dialect: 'sqlite', storage: ':memory:' };
      await isolated?.close();
      app = mockServer({ acl: false, database });
      await new UsersPlugin(app, { name: 'audit-test-users' }).beforeLoad();
      const db = app.db;
      db.collection({
        name: 'users',
        timestamps: false,
        createdBy: true,
        updatedBy: true,
        fields: [
          { name: 'id', type: 'bigInt', primaryKey: true },
          { name: 'nickname', type: 'string' },
        ],
      });
      await seedConfigStore(db);
      await seedAclScopes(db);
      docs = db.collection({
        name: 'documents',
        timestamps: false,
        createdBy: true,
        updatedBy: true,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true, autoIncrement: true },
          { name: 'name', type: 'string' },
          { name: 'tenantId', type: 'string' },
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
      store = new AccessConfigStore(db, (value) =>
        resolveModelMetadata(db.getCollection(value.collectionName), {
          resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
        }),
      );
      await store.save(mainIdentity, { ...configFor(ownerCondition), revision: 0 }, { userId: 28 });
      adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
      queries = new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection)));
      ctx = { state: { currentUser: { id: 28 } } };
      await adapter.prepare(ctx, [mainIdentity]);
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      try {
        if (dialect === 'postgres') await app?.db.sequelize.drop({ cascade: true });
      } finally {
        await app?.destroy();
      }
    });

    const create = (values: Record<string, unknown> = { name: 'Created' }, authenticated = actor) =>
      new AccessCreationService(app.db, adapter, queries).withCreatedRecords(
        ctx,
        mainIdentity,
        authenticated,
        { values: [values] },
        async (plan) => [
          await docs.repository.create({ values: plan.values[0], transaction: plan.transaction, context: ctx }),
        ],
      );
    const seed = () =>
      docs.repository.create({
        values: { name: 'Before', tenantId: 'B' },
        context: { state: { currentUser: { id: 29 } } },
      });
    const update = (id: number, write = true) =>
      new AccessMutationService(app.db, adapter, queries).withExistingRecords(
        ctx,
        mainIdentity,
        actor,
        { operation: 'update', keys: [id], values: { name: 'After' } },
        async (plan) => {
          if (write)
            for (const row of plan.records)
              await docs.repository.update({
                filterByTk: row.get('id'),
                values: plan.valuesFor(row),
                transaction: plan.transaction,
                context: ctx,
              });
        },
      );

    it('keeps framework-created audit identities when an authorized source is inserted', async () => {
      const result = await new AccessCreationService(app.db, adapter, queries).withCreatedRecords(
        ctx,
        mainIdentity,
        actor,
        { values: [{ name: 'Created' }] },
        async (plan) => [
          await docs.repository.create({ values: plan.values[0], transaction: plan.transaction, context: ctx }),
        ],
      );
      expect(result.affected).toBe(1);
      expect((await docs.model.findByPk(result.keys[0]))!.get()).toMatchObject({
        name: 'Created',
        tenantId: 'B',
        createdById: 28,
        updatedById: 28,
      });
    });
    it('lets the framework update only the modifier while retaining the original creator', async () => {
      const record = await docs.repository.create({
        values: { name: 'Before', tenantId: 'B' },
        context: { state: { currentUser: { id: 29 } } },
      });
      const result = await new AccessMutationService(app.db, adapter, queries).withExistingRecords(
        ctx,
        mainIdentity,
        actor,
        { operation: 'update', keys: [record.get('id')], values: { name: 'After' } },
        async (plan) => {
          for (const row of plan.records)
            await docs.repository.update({
              filterByTk: row.get('id'),
              values: plan.valuesFor(row),
              transaction: plan.transaction,
              context: ctx,
            });
        },
      );
      expect(result.affected).toBe(1);
      expect((await docs.model.findByPk(record.get('id')))!.get()).toMatchObject({
        name: 'After',
        tenantId: 'B',
        createdById: 29,
        updatedById: 28,
      });
    });
    it.each(['createdById', 'updatedById'])('does not allow a client-supplied %s', async (name) => {
      await expect(create({ name: 'Forged', [name]: 29 })).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(await docs.model.count()).toBe(0);
    });
    it.each(['createdById', 'updatedById'])('rolls back an insert hook forging %s', async (name) => {
      docs.model.addHook('afterCreate', 'forge-audit', async (row, options) => {
        await docs.model.update(
          { [name]: 30 },
          { where: { id: row.get('id') }, transaction: options.transaction, hooks: false },
        );
      });
      await expect(create()).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(await docs.model.count()).toBe(0);
    });
    it.each(['createdById', 'updatedById'])('rolls back an update hook forging %s', async (name) => {
      const record = await seed();
      docs.model.addHook('afterUpdate', 'forge-audit', async (row, options) => {
        await docs.model.update(
          { [name]: 30 },
          { where: { id: row.get('id') }, transaction: options.transaction, hooks: false },
        );
      });
      await expect(update(record.get('id'))).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect((await docs.model.findByPk(record.get('id')))!.get()).toMatchObject({
        name: 'Before',
        createdById: 29,
        updatedById: 29,
      });
    });
    it('does not rewrite audit values when the writer makes no actual change', async () => {
      const record = await seed();
      await update(record.get('id'), false);
      expect((await docs.model.findByPk(record.get('id')))!.get()).toMatchObject({
        name: 'Before',
        createdById: 29,
        updatedById: 29,
      });
    });
    it('accepts empty audit identities for a background actor without a user', async () => {
      delete ctx.state.currentUser;
      await create(undefined, { ...actor, userId: undefined });
      expect((await docs.model.findOne())!.get()).toMatchObject({ createdById: null, updatedById: null });
    });
    it('does not accept the context user in place of a different authenticated actor', async () => {
      await expect(create(undefined, { ...actor, userId: 29 })).rejects.toMatchObject({
        code: 'INVALID_ACCESS_MUTATION',
      });
      expect(await docs.model.count()).toBe(0);
    });
    it.each(['dataIndex', 'createOnly', 'dataType'])(
      'rejects a hook changing the captured audit %s',
      async (option) => {
        docs.model.addHook('afterCreate', 'change-audit-contract', () => {
          docs.getField('createdById').options[option] =
            option === 'dataIndex' ? 'state.currentUser.other' : option === 'dataType' ? 'string' : false;
        });
        await expect(create()).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
        expect(await docs.model.count()).toBe(0);
      },
    );
    it('keeps an ordinary user foreign key protected', async () => {
      docs.setField('reviewer', { type: 'belongsTo', target: 'users', foreignKey: 'reviewerId' });
      await docs.model.sync({ alter: true });
      docs.model.addHook('afterCreate', 'forge-reviewer', async (row, options) => {
        await docs.model.update(
          { reviewerId: 28 },
          { where: { id: row.get('id') }, transaction: options.transaction, hooks: false },
        );
      });
      await expect(create()).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(await docs.model.count()).toBe(0);
    });
    it('does not exempt an audit key used as another relation target key', async () => {
      const record = await seed();
      app.db.collection({ name: 'external_document_links', timestamps: false });
      app.db.collection({
        name: 'external_records',
        timestamps: false,
        fields: [
          {
            name: 'documents',
            type: 'belongsToMany',
            target: 'documents',
            targetKey: 'updatedById',
            through: 'external_document_links',
            foreignKey: 'externalId',
            otherKey: 'modifierId',
          },
        ],
      });
      // Registered metadata requires protection even when this root operation writes no connections.
      await expect(update(record.get('id'))).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect((await docs.model.findByPk(record.get('id')))!.get()).toMatchObject({ name: 'Before', updatedById: 29 });
    });
    it('rejects a changed physical audit column mapping before final verification', async () => {
      const attribute = docs.model.rawAttributes.updatedById;
      const original = attribute.field;
      docs.model.addHook('afterCreate', 'hide-audit-change', async (row, options) => {
        await docs.model.update(
          { updatedById: 30 },
          { where: { id: row.get('id') }, transaction: options.transaction, hooks: false },
        );
        attribute.field = docs.model.rawAttributes.createdById.field;
      });
      try {
        await expect(create()).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      } finally {
        attribute.field = original;
      }
      expect(await docs.model.count()).toBe(0);
    });
    it('checks audit column mappings before a read that can restore them in its hooks', async () => {
      const record = await seed();
      const attribute = docs.model.rawAttributes.updatedById;
      const original = attribute.field;
      app.db.sequelize.addHook('afterQuery', 'restore-audit-mapping', (options) => {
        if (options.type === 'SELECT' && (options as { model?: typeof docs.model }).model === docs.model)
          attribute.field = original;
      });
      try {
        await expect(
          new AccessMutationService(app.db, adapter, queries).withExistingRecords(
            ctx,
            mainIdentity,
            actor,
            { operation: 'update', keys: [record.get('id')], values: { name: 'After' } },
            async (plan) => {
              await docs.model.update(
                { name: 'After', updatedById: 30 },
                { where: { id: record.get('id') }, transaction: plan.transaction, hooks: false },
              );
              attribute.field = docs.model.rawAttributes.createdById.field;
            },
          ),
        ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      } finally {
        attribute.field = original;
      }
      expect((await docs.model.findByPk(record.get('id')))!.get()).toMatchObject({ name: 'Before', updatedById: 29 });
    });
    it('keeps user self-association audits usable for root creation and modification', async () => {
      const users = app.db.getCollection('users');
      const userIdentity = identity(users);
      await app.db.getRepository('collections').create({ values: { name: 'users', key: userIdentity.collectionKey } });
      await store.save(
        userIdentity,
        { ...configFor({ type: 'constant', value: true }), ownership: { enabled: false }, revision: 0 },
        { userId: 28 },
      );
      adapter.release(ctx);
      await adapter.prepare(ctx, [mainIdentity, userIdentity]);
      await new AccessCreationService(app.db, adapter, queries).withCreatedRecords(
        ctx,
        userIdentity,
        actor,
        { values: [{ id: 31, nickname: 'Created' }] },
        async (plan) => [
          await users.repository.create({ values: plan.values[0], transaction: plan.transaction, context: ctx }),
        ],
      );
      expect((await users.model.findByPk(31))!.get()).toMatchObject({
        nickname: 'Created',
        createdById: 28,
        updatedById: 28,
      });
      await new AccessMutationService(app.db, adapter, queries).withExistingRecords(
        ctx,
        userIdentity,
        actor,
        { operation: 'update', keys: [29], values: { nickname: 'Updated' } },
        async (plan) => {
          await users.repository.update({
            filterByTk: 29,
            values: plan.valuesFor(plan.records[0]),
            transaction: plan.transaction,
            context: ctx,
          });
        },
      );
      expect((await users.model.findByPk(29))!.get()).toMatchObject({
        nickname: 'Updated',
        createdById: null,
        updatedById: 28,
      });
    });
    it('does not mistake another source table foreign key for this table audit column', async () => {
      const record = await seed();
      app.db.collection({
        name: 'incoming_references',
        timestamps: false,
        fields: [{ name: 'document', type: 'belongsTo', target: 'documents', foreignKey: 'updatedById' }],
      });
      await update(record.get('id'));
      expect((await docs.model.findByPk(record.get('id')))!.get()).toMatchObject({
        name: 'After',
        updatedById: 28,
        createdById: 29,
      });
    });
  },
);

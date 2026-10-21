import { pathToFileURL } from 'node:url';
import { mockServer, type MockServer } from '@tachybase/test';
import { ACL, Resourcer, type Collection, type Context } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { AccessResourceMutationHandler } from '../../access-control/resource-mutation-handler';
import type { AccessRootReadContext } from '../../access-control/root-read-context';
import { AccessRootReadHandler } from '../../access-control/root-read-handler';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_ENTRY;
const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const coreAvailable = coreEntry || 'registerActionParamsResolver' in ACL.prototype;
const actor = { tenantId: 'B', roleName: 'editor', userId: 28 };

/** Real HTTP/ACL and PostgreSQL transactions; server fixture identities, not real authentication. */
describe.skipIf(!coreAvailable || !postgresUrl)('reference updates over real HTTP resources', () => {
  let app: MockServer;
  let acl: ACL;
  let adapter: AccessAclScopeAdapter;
  let unregister: (() => void) | undefined;
  let tenantScopeId: number;
  const identity = (collection: Collection) => ({
    ...mainIdentity,
    collectionName: collection.name,
    collectionKey: `${collection.name}-key`,
  });
  const identities = () =>
    ['documents', 'projects', 'document_projects'].map((name) => identity(app.db.getCollection(name)));

  beforeEach(async () => {
    // Validate the dedicated local URL before passing its options to MockServer's database factory.
    const isolated = isolatedPostgresDatabase(postgresUrl!);
    const database = isolated.options;
    await isolated.close();
    app = mockServer({ acl: false, registerActions: true, database, resourcer: { prefix: '/api' } });
    const db = app.db;
    await seedConfigStore(db);
    await seedAclScopes(db);
    for (const name of ['documents', 'projects'])
      db.collection({
        name,
        timestamps: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true, autoIncrement: true },
          { name: 'tenantId', type: 'string' },
          { name: 'name', type: 'string' },
        ],
      });
    const docs = db.getCollection('documents');
    db.collection({ name: 'document_projects', timestamps: false });
    docs.setField('project', { type: 'belongsTo', target: 'projects', foreignKey: 'projectId' });
    docs.setField('projects', {
      type: 'belongsToMany',
      target: 'projects',
      through: 'document_projects',
      foreignKey: 'documentId',
      otherKey: 'projectId',
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
    await db.getCollection('tenants').model.create({ id: 'B', enabled: true });
    const store = new AccessConfigStore(db, (value) =>
      resolveModelMetadata(db.getCollection(value.collectionName), {
        resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
      }),
    );
    for (const name of ['projects', 'document_projects'])
      await db.getRepository('collections').create({ values: { key: `${name}-key`, name } });
    for (const name of ['documents', 'projects']) {
      const config = configFor(ownerCondition);
      config.rules.push({
        ...configFor(
          {
            type: 'compare',
            operator: 'eq',
            left: { type: 'field', path: 'name' },
            right: { type: 'literal', value: 'Visible' },
          },
          'visibility',
        ).rules[0],
        id: 'visible',
      });
      await store.save(identity(db.getCollection(name)), { ...config, revision: 0 }, { userId: 28 });
    }
    await docs.model.bulkCreate([
      { id: 3, name: 'Owned', tenantId: 'B', projectId: null },
      { id: 4, name: 'Visible', tenantId: 'H', projectId: null },
    ]);
    await db.getCollection('projects').model.bulkCreate([
      { id: 101, name: 'Owned', tenantId: 'B' },
      { id: 102, name: 'Visible', tenantId: 'H' },
      { id: 103, name: 'Hidden', tenantId: 'C' },
    ]);
    const CoreACL = coreEntry ? (await import(/* @vite-ignore */ pathToFileURL(coreEntry).href)).ACL : ACL;
    acl = new CoreACL();
    app.mainDataSource.acl = acl;
    acl.define({ role: 'editor' });
    acl.setAvailableAction('view', { aliases: ['get', 'list'] });
    acl.setAvailableAction('update', {});
    tenantScopeId = (
      await db.getRepository('dataSourcesRolesResourcesScopes').create({
        values: { key: 'tenant', dataSourceKey: 'main', scope: { tenantId: '{{ ctx.state.currentTenant.id }}' } },
      })
    ).get('id');
    await grant('documents', 'view', ['id', 'name']);
    await grant('projects', 'view', ['id', 'name']);
    await grant('documents', 'update', ['name', 'project', 'projects']);
    adapter = new AccessAclScopeAdapter(acl, 'main', store, db);
    unregister = adapter.register();
    const queries = new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection)));
    const reader = new AccessRootReadHandler(db, adapter, queries, identity);
    const writer = new AccessResourceMutationHandler(db, adapter, queries, identity);
    app.resourcer.use(
      async (ctx, next) => {
        ctx.state.currentRole = actor.roleName;
        ctx.state.currentTenant = { id: actor.tenantId };
        ctx.state.currentUser = { id: actor.userId };
        await adapter.prepare(ctx, identities());
        try {
          await next();
        } finally {
          adapter.release(ctx);
        }
      },
      { tag: 'access-reference-preparation', after: 'auth' },
    );
    app.resourcer.use(acl.middleware(), { tag: 'access-reference-acl', after: 'access-reference-preparation' });
    for (const name of ['documents', 'projects'])
      app.resourcer.define({
        name,
        actions: Object.fromEntries(
          ['get', 'list'].map((action) => [
            action,
            async (ctx: Context & { permission: unknown }) => {
              await reader.handleResourceWithRelatedContexts(ctx, actor, async () => null);
            },
          ]),
        ),
      });
    app.resourcer.registerActionHandler('documents:update', async (resourceContext) => {
      const ctx = resourceContext as Context & { permission: unknown };
      if (!('permission' in ctx)) throw new Error('ACL middleware did not finalize this request');
      const related: AccessRootReadContext[] = [];
      try {
        await writer.handle(ctx, actor, {
          read: async (collection) => {
            // A separate neutral list decision, using the same persisted role grants and ACL middleware.
            // Never forward the source request's fields, filter, key or values to the target decision.
            const resourcer = new Resourcer();
            resourcer.define({ name: collection.name, actions: { list: {} } });
            const action = resourcer.getAction(collection.name, 'list').clone();
            Object.assign(action, { resourceName: collection.name, actionName: 'list' });
            action.mergeParams({ resourceName: collection.name, actionName: 'list', filterByTk: undefined });
            const decision = {
              db,
              action,
              permission: undefined as unknown,
              state: ctx.state,
              get: ctx.get.bind(ctx),
              logger: ctx.logger,
              throw: ctx.throw.bind(ctx),
            };
            related.push(decision);
            await adapter.prepare(decision, identities());
            await acl.middleware()(decision as never, async () => {});
            return decision;
          },
          update: async () => null,
          source: async () => null,
        });
      } finally {
        for (const decision of related) adapter.release(decision);
      }
    });
  });

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    try {
      await app?.db.sequelize.drop({ cascade: true });
    } finally {
      await app?.destroy();
    }
  });

  async function grant(resourceName: string, name: 'view' | 'update', fields: string[], filter?: object) {
    const db = app.db;
    const scopeId = filter
      ? (
          await db.getRepository('dataSourcesRolesResourcesScopes').create({
            values: { key: `custom-${resourceName}-${name}`, dataSourceKey: 'main', scope: filter },
          })
        ).get('id')
      : tenantScopeId;
    const action = await db.getRepository('dataSourcesRolesResourcesScopesActions').create({
      values: { name, fields, scopeId },
    });
    await action.writeToACL({
      acl,
      role: acl.getRole('editor'),
      resourceName,
      associationFieldsActions: {},
      grantHelper: {},
    });
  }

  const row = async (name = 'documents', id = 3) => (await app.db.getCollection(name).model.findByPk(id))?.toJSON();
  const links = async () =>
    (await app.db.getCollection('document_projects').model.findAll({ order: [['projectId', 'ASC']] })).map((record) =>
      Number(record.get('projectId')),
    );
  const update = (values: object, id = 3) => app.agent().resource('documents').update({ filterByTk: id, values });

  it('links a visible-only target without claiming or changing that target', async () => {
    const visible = await app.agent().resource('projects').get({ filterByTk: 102 });
    expect(visible.status).toBe(200);
    expect(visible.body).toEqual({ data: { id: 102, name: 'Visible' } });
    const response = await update({ name: 'Edited', project: 102, projects: [102] });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
    expect(await row()).toEqual({ id: 3, name: 'Edited', tenantId: 'B', projectId: 102 });
    expect(await links()).toEqual([102]);
    expect(await row('projects', 102)).toEqual({ id: 102, name: 'Visible', tenantId: 'H' });
  });

  it('rejects reference edits to a source that is only visible', async () => {
    const visible = await app.agent().resource('documents').get({ filterByTk: 4 });
    expect(visible.body).toEqual({ data: { id: 4, name: 'Visible' } });
    const response = await update({ name: 'Forbidden', project: 101, projects: [101] }, 4);
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    expect(await row('documents', 4)).toEqual({ id: 4, name: 'Visible', tenantId: 'H', projectId: null });
    expect(await links()).toEqual([]);
  });

  it.each([
    { project: 103, projects: [101] },
    { project: 101, projects: [101, 103] },
  ])('rolls back scalar and reference changes when a target is hidden: %j', async (references) => {
    const response = await update({ name: 'Forbidden', ...references });
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    expect(await row()).toEqual({ id: 3, name: 'Owned', tenantId: 'B', projectId: null });
    expect(await links()).toEqual([]);
  });

  it('updates a single belongs-to reference without a join-table mutation', async () => {
    const response = await update({ project: 102 });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
    expect(await row()).toEqual({ id: 3, name: 'Owned', tenantId: 'B', projectId: 102 });
    expect(await links()).toEqual([]);
    expect(await row('projects', 102)).toEqual({ id: 102, name: 'Visible', tenantId: 'H' });
  });

  it('clears existing references without deleting or claiming the targets', async () => {
    expect((await update({ project: 102, projects: [101, 102] })).status).toBe(200);
    const response = await update({ project: null, projects: [] });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
    expect(await row()).toEqual({ id: 3, name: 'Owned', tenantId: 'B', projectId: null });
    expect(await links()).toEqual([]);
    expect(await row('projects', 102)).toEqual({ id: 102, name: 'Visible', tenantId: 'H' });
    expect(await app.db.getCollection('projects').model.count()).toBe(3);
  });

  it.each(['documents:update', 'projects:view'])(
    'preserves the missing operation denial for %s',
    async (permission) => {
      acl.getRole('editor').revokeAction(permission);
      const response = await update({ name: 'Forbidden', project: 102, projects: [102] });
      expect(response.status).toBe(403);
      expect(response.body).not.toHaveProperty('data');
      expect(await row()).toEqual({ id: 3, name: 'Owned', tenantId: 'B', projectId: null });
      expect(await links()).toEqual([]);
    },
  );

  it('retains source role conditions in addition to ownership', async () => {
    await grant('documents', 'update', ['name', 'project', 'projects'], { name: 'Visible' });
    const response = await update({ name: 'Forbidden', project: 102, projects: [102] });
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    expect(await row()).toEqual({ id: 3, name: 'Owned', tenantId: 'B', projectId: null });
    expect(await links()).toEqual([]);
  });

  it('does not let target visibility override its custom role filter', async () => {
    await grant('projects', 'view', ['id', 'name'], { id: 101 });
    const response = await update({ name: 'Forbidden', project: 101, projects: [102] });
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    expect(await row()).toEqual({ id: 3, name: 'Owned', tenantId: 'B', projectId: null });
    expect(await links()).toEqual([]);
  });

  it('links a visible target that satisfies its independent custom role filter', async () => {
    await grant('projects', 'view', ['id', 'name'], { id: 102 });
    const response = await update({ project: 102, projects: [102] });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
    expect(await row()).toEqual({ id: 3, name: 'Owned', tenantId: 'B', projectId: 102 });
    expect(await links()).toEqual([102]);
  });

  it('requires read permission for the referenced target key', async () => {
    await grant('projects', 'view', ['name']);
    const response = await update({ name: 'Forbidden', project: 102 });
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
    expect(await row()).toEqual({ id: 3, name: 'Owned', tenantId: 'B', projectId: null });
  });

  it('requires field permission for every submitted association', async () => {
    await grant('documents', 'update', ['name', 'project']);
    const response = await update({ name: 'Forbidden', project: 101, projects: [102] });
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
    expect(await row()).toEqual({ id: 3, name: 'Owned', tenantId: 'B', projectId: null });
    expect(await links()).toEqual([]);
  });

  it('does not transfer ownership alongside an otherwise permitted reference change', async () => {
    const response = await update({ tenantId: 'C', project: 102, projects: [102] });
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    expect(await row()).toEqual({ id: 3, name: 'Owned', tenantId: 'B', projectId: null });
    expect(await links()).toEqual([]);
  });

  it('rejects nested target edits rather than treating them as reference keys', async () => {
    const response = await update({ name: 'Forbidden', project: { id: 102, name: 'Changed' } });
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
    expect(await row()).toEqual({ id: 3, name: 'Owned', tenantId: 'B', projectId: null });
    expect(await row('projects', 102)).toEqual({ id: 102, name: 'Visible', tenantId: 'H' });
  });

  it('rolls back source edits, removed links and inserted links when a join hook fails', async () => {
    expect((await update({ project: 101, projects: [101] })).status).toBe(200);
    let observed: unknown;
    app.db.getCollection('document_projects').model.addHook('afterBulkCreate', async (_records, options) => {
      observed = {
        source: (
          await app.db.getCollection('documents').model.findByPk(3, { transaction: options.transaction })
        )?.toJSON(),
        links: (
          await app.db.getCollection('document_projects').model.findAll({ transaction: options.transaction })
        ).map((record) => Number(record.get('projectId'))),
      };
      throw new Error('HTTP reference rollback fixture');
    });
    const response = await update({ name: 'Edited', project: 102, projects: [102] });
    expect(response.status).toBe(500);
    expect(response.body).not.toHaveProperty('data');
    expect(observed).toEqual({
      source: { id: 3, name: 'Edited', tenantId: 'B', projectId: 102 },
      links: [102],
    });
    expect(await row()).toEqual({ id: 3, name: 'Owned', tenantId: 'B', projectId: 101 });
    expect(await links()).toEqual([101]);
    expect(await row('projects', 102)).toEqual({ id: 102, name: 'Visible', tenantId: 'H' });
  });
});

import { pathToFileURL } from 'node:url';
import { mockServer, supertest, type MockServer } from '@tachybase/test';
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
const coreResourcerEntry = process.env.TENANT_ACCESS_CORE_RESOURCER_ENTRY;
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
    if (coreResourcerEntry) {
      // Exercise the real built core router on this fixture only, without changing installed dependencies.
      const { Resourcer: CoreResourcer } = await import(/* @vite-ignore */ pathToFileURL(coreResourcerEntry).href);
      app.resourcer.restApiMiddleware = CoreResourcer.prototype.restApiMiddleware;
    }
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
    const mutate = async (ctx: Context & { permission: unknown }) => {
      if (!('permission' in ctx)) throw new Error('ACL middleware did not finalize this request');
      const related: AccessRootReadContext[] = [];
      const authorize = async (collection: Collection, actionName: 'list' | 'add' | 'remove' | 'set') => {
        // A separate neutral root decision, using the same persisted role grants and ACL middleware.
        // Never forward the original request's fields, filter, key or values to this decision.
        const resourcer = new Resourcer();
        resourcer.define({ name: collection.name, actions: { [actionName]: {} } });
        const action = resourcer.getAction(collection.name, actionName).clone();
        Object.assign(action, { resourceName: collection.name, actionName });
        action.mergeParams({ resourceName: collection.name, actionName, filterByTk: undefined });
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
      };
      try {
        await writer.handle(ctx, actor, {
          read: (collection) => authorize(collection, 'list'),
          update: async () => null,
          source: authorize,
        });
      } finally {
        for (const decision of related) adapter.release(decision);
      }
    };
    for (const path of [
      'documents:update',
      ...['add', 'remove', 'set'].map((operation) => `documents.projects:${operation}`),
    ])
      app.resourcer.registerActionHandler(path, (ctx) => mutate(ctx as Context & { permission: unknown }));
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

  async function grant(
    resourceName: string,
    name: 'view' | 'update' | 'add' | 'remove' | 'set',
    fields: string[],
    filter?: object,
  ) {
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
  async function grantLink(operation: 'add' | 'remove' | 'set') {
    acl.setAvailableAction(operation, {});
    await grant('documents', operation, ['projects']);
    await grant('projects', operation, ['id']);
  }
  const link = (operation: 'add' | 'remove' | 'set', values: number[], source: string | number = 3) =>
    supertest(app.callback()).post(`/api/documents/${source}/projects:${operation}`).send(values);
  const seedLinks = (ids: number[], source = 3) =>
    app.db
      .getCollection('document_projects')
      .model.bulkCreate(ids.map((projectId) => ({ documentId: source, projectId })));

  it.each([
    { operation: 'add', before: [], after: [102] },
    { operation: 'remove', before: [101, 102], after: [101] },
    { operation: 'set', before: [101], after: [102] },
  ] as const)(
    'handles the concrete $operation route without changing the target',
    async ({ operation, before, after }) => {
      await grantLink(operation);
      await seedLinks([...before]);
      const response = await link(operation, [102]);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
      expect(await links()).toEqual(after);
      expect(await row()).toEqual({ id: 3, name: 'Owned', tenantId: 'B', projectId: null });
      expect(await row('projects', 102)).toEqual({ id: 102, name: 'Visible', tenantId: 'H' });
    },
  );

  it.each(['add', 'remove', 'set'] as const)(
    'denies concrete %s on a source that is only visible',
    async (operation) => {
      await grantLink(operation);
      await seedLinks([101], 4);
      const response = await link(operation, [operation === 'remove' ? 101 : 102], 4);
      expect(response.status).toBe(403);
      expect(response.body).not.toHaveProperty('data');
      expect(await links()).toEqual([101]);
      expect(await row('documents', 4)).toEqual({ id: 4, name: 'Visible', tenantId: 'H', projectId: null });
    },
  );

  it.each([
    ['add', 'documents'],
    ['remove', 'documents'],
    ['set', 'documents'],
    ['add', 'projects'],
    ['remove', 'projects'],
    ['set', 'projects'],
  ] as const)('requires the concrete %s grant on %s independently', async (operation, resource) => {
    await grantLink(operation);
    await seedLinks([101]);
    acl.getRole('editor').revokeAction(`${resource}:${operation}`);
    const response = await link(operation, [operation === 'remove' ? 101 : 102]);
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    expect(await links()).toEqual([101]);
  });

  it('retains the independent source action filter on concrete additions', async () => {
    await grantLink('add');
    await grant('documents', 'add', ['projects'], { name: 'Other' });
    const response = await link('add', [102]);
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    expect(await links()).toEqual([]);
  });

  it.each(['remove', 'set'] as const)('checks target action conditions on links removed by %s', async (operation) => {
    await grantLink(operation);
    await grant('projects', operation, ['id'], { id: 102 });
    await seedLinks([101]);
    const response = await link(operation, [operation === 'remove' ? 101 : 102]);
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    expect(await links()).toEqual([101]);
  });

  it('retains the target list scope when adding a visible reference', async () => {
    await grantLink('add');
    await grant('projects', 'view', ['id'], { id: 101 });
    const response = await link('add', [102]);
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    expect(await links()).toEqual([]);
  });

  it.each(['add', 'set'] as const)('rejects hidden additions in concrete %s', async (operation) => {
    await grantLink(operation);
    await seedLinks([101]);
    const response = await link(operation, [102, 103]);
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    expect(await links()).toEqual([101]);
  });

  it('removes an unreadable old target without requiring list permission or changing it', async () => {
    await grantLink('remove');
    await seedLinks([103]);
    acl.getRole('editor').revokeAction('projects:view');
    const response = await supertest(app.callback()).post('/api/documents/3/projects:remove?filterByTk=103');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
    expect(await links()).toEqual([]);
    expect(await row('projects', 103)).toEqual({ id: 103, name: 'Hidden', tenantId: 'C' });
  });

  it('preserves an unchanged unreadable link without requiring list permission', async () => {
    await grantLink('add');
    await seedLinks([103]);
    acl.getRole('editor').revokeAction('projects:view');
    const response = await link('add', [103]);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { keys: [], affected: 0 } });
    expect(await links()).toEqual([103]);
    expect(await row('projects', 103)).toEqual({ id: 103, name: 'Hidden', tenantId: 'C' });
  });

  it.each([undefined, {}])('does not clear links when no target selector was sent: %j', async (body) => {
    await grantLink('set');
    await seedLinks([101, 103]);
    acl.getRole('editor').revokeAction('projects:view');
    const request = supertest(app.callback()).post('/api/documents/3/projects:set');
    const response = await (body === undefined ? request : request.send(body));
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
    expect(await links()).toEqual([101, 103]);
    expect(await app.db.getCollection('projects').model.count()).toBe(3);
  });

  it.skipIf(!!coreResourcerEntry)('retains links when the installed core drops an empty array body', async () => {
    await grantLink('set');
    await seedLinks([101, 103]);
    const response = await link('set', []);
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
    expect(await links()).toEqual([101, 103]);
  });

  describe.skipIf(!coreResourcerEntry)('explicit empty selector transport', () => {
    it('clears links without requiring target list permission or changing the targets', async () => {
      await grantLink('set');
      await seedLinks([101, 103]);
      acl.getRole('editor').revokeAction('projects:view');
      const response = await link('set', []);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
      expect(await links()).toEqual([]);
      expect(await row('projects', 101)).toEqual({ id: 101, name: 'Owned', tenantId: 'B' });
      expect(await row('projects', 103)).toEqual({ id: 103, name: 'Hidden', tenantId: 'C' });
      expect(await app.db.getCollection('projects').model.count()).toBe(3);
    });

    it.each(['documents', 'projects'])('requires the independent set grant on %s to clear links', async (resource) => {
      await grantLink('set');
      await seedLinks([101]);
      acl.getRole('editor').revokeAction(`${resource}:set`);
      const response = await link('set', []);
      expect(response.status).toBe(403);
      expect(response.body).not.toHaveProperty('data');
      expect(await links()).toEqual([101]);
    });

    it('does not clear a source that is only visible', async () => {
      await grantLink('set');
      await seedLinks([101], 4);
      const response = await link('set', [], 4);
      expect(response.status).toBe(403);
      expect(response.body).not.toHaveProperty('data');
      expect(await links()).toEqual([101]);
    });

    it('checks target set conditions on every removed link', async () => {
      await grantLink('set');
      await grant('projects', 'set', ['id'], { id: 101 });
      await seedLinks([101, 103]);
      const response = await link('set', []);
      expect(response.status).toBe(403);
      expect(response.body).not.toHaveProperty('data');
      expect(await links()).toEqual([101, 103]);
    });

    it('rejects an empty body array combined with a query selector', async () => {
      await grantLink('set');
      await seedLinks([101]);
      const response = await supertest(app.callback()).post('/api/documents/3/projects:set?filterByTk=101').send([]);
      expect(response.status).toBe(400);
      expect(response.body).not.toHaveProperty('data');
      expect(await links()).toEqual([101]);
    });

    it('restores cleared links when a post-delete hook fails', async () => {
      await grantLink('set');
      await seedLinks([101, 103]);
      let observed: unknown;
      app.db.getCollection('document_projects').model.addHook('afterBulkDestroy', async (options) => {
        observed = await app.db.getCollection('document_projects').model.count({ transaction: options.transaction });
        throw new Error('HTTP empty set rollback fixture');
      });
      const response = await link('set', []);
      expect(response.status).toBe(500);
      expect(response.body).not.toHaveProperty('data');
      expect(observed).toBe(0);
      expect(await links()).toEqual([101, 103]);
    });
  });

  it('accepts the core array query selector on a concrete set', async () => {
    await grantLink('set');
    const response = await supertest(app.callback()).post(
      '/api/documents/3/projects:set?filterByTks[]=101&filterByTks[]=102',
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
    expect(await links()).toEqual([101, 102]);
  });

  it('rejects competing body and query selectors without changing links', async () => {
    await grantLink('set');
    await seedLinks([101]);
    const response = await supertest(app.callback()).post('/api/documents/3/projects:set?filterByTk=101').send([102]);
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
    expect(await links()).toEqual([101]);
  });

  it('does not treat the read placeholder as a writable concrete source', async () => {
    await grantLink('add');
    const response = await link('add', [102], '_');
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
    expect(await links()).toEqual([]);
  });

  it.each(['documents', 'projects'])('requires concrete action field permissions on %s', async (resource) => {
    await grantLink('add');
    await grant(resource, 'add', ['name']);
    const response = await link('add', [102]);
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
    expect(await links()).toEqual([]);
  });

  it('rolls back removals and insertions when a concrete set hook fails', async () => {
    await grantLink('set');
    await seedLinks([101]);
    let observed: unknown;
    app.db.getCollection('document_projects').model.addHook('afterBulkCreate', async (_records, options) => {
      observed = (
        await app.db.getCollection('document_projects').model.findAll({ transaction: options.transaction })
      ).map((record) => Number(record.get('projectId')));
      throw new Error('HTTP concrete set rollback fixture');
    });
    const response = await link('set', [102]);
    expect(response.status).toBe(500);
    expect(response.body).not.toHaveProperty('data');
    expect(observed).toEqual([102]);
    expect(await links()).toEqual([101]);
    expect(await row('projects', 102)).toEqual({ id: 102, name: 'Visible', tenantId: 'H' });
  });

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

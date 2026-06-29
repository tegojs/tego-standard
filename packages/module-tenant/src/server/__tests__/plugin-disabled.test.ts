/**
 * Regression tests: module-tenant NOT loaded on the server.
 *
 * When PluginTenantServer is absent from the application,
 * tenant-specific server capabilities (actions, middleware, collections)
 * must NOT be registered, and the application must start without errors.
 */
import { createMockServer, MockServer } from '@tachybase/test';

describe('module-tenant not loaded (server)', () => {
  let app: MockServer;

  beforeAll(async () => {
    app = await createMockServer({
      registerActions: true,
      acl: true,
      database: { dialect: 'sqlite' },
      plugins: ['acl', 'error-handler', 'users', 'collection-manager', 'data-source-manager'],
    });
  });

  afterAll(async () => {
    await app.destroy();
  });

  it('should start the application without errors', () => {
    expect(app).toBeTruthy();
    expect(app.db).toBeTruthy();
  });

  it('should not have the tenant plugin registered', () => {
    const tenantPlugin = app.pm.get('tenant');
    expect(tenantPlugin).toBeFalsy();
  });

  it('should not have tenants collection', () => {
    // The tenants collection is registered by PluginTenantServer.loadCollections().
    // When the plugin is not loaded, this collection should not exist.
    const tenantsCollection = app.db.getCollection('tenants');
    expect(tenantsCollection).toBeFalsy();
  });

  it('should not have tenantUsers collection', () => {
    const tenantUsersCollection = app.db.getCollection('tenantUsers');
    expect(tenantUsersCollection).toBeFalsy();
  });

  it('should not register tenants:available action handler', () => {
    const handler = app.resourcer.getRegisteredHandler('tenants:available');
    expect(handler).toBeFalsy();
  });

  it('should not register tenants:current action handler', () => {
    const handler = app.resourcer.getRegisteredHandler('tenants:current');
    expect(handler).toBeFalsy();
  });

  it('should not register tenants:switch action handler', () => {
    const handler = app.resourcer.getRegisteredHandler('tenants:switch');
    expect(handler).toBeFalsy();
  });

  it('should not register pm.tenant.manage ACL snippet', () => {
    const snippet = (app as any).acl?.snippetManager?.snippets?.get('pm.tenant.manage');
    expect(snippet).toBeFalsy();
  });

  it('should not add tenantId context field to a tenantScoped collection', async () => {
    const Post = app.db.collection({
      name: 'no_tenant_posts',
      tenancy: 'tenantScoped',
    });

    // Without the tenant plugin, the ensureTenantIdField hook is never
    // registered, so tenantId should NOT be auto-created.
    expect(Post.hasField('tenantId')).toBeFalsy();
  });

  it('should not add tenantId context field to a tenantInherited collection', async () => {
    const Article = app.db.collection({
      name: 'no_tenant_articles',
      tenancy: 'tenantInherited',
    });

    expect(Article.hasField('tenantId')).toBeFalsy();
  });

  it('should allow CRUD on a shared collection without tenant context', async () => {
    const Item = app.db.collection({
      name: 'shared_items',
      fields: [{ name: 'title', type: 'string' }],
    });
    await app.db.sync();

    const created = await Item.repository.create({ values: { title: 'test' } });
    expect(created.get('title')).toBe('test');

    const found = await Item.repository.findOne({ filter: { title: 'test' } });
    expect(found).toBeTruthy();
    expect(found.get('title')).toBe('test');

    await Item.repository.update({ filterByTk: created.get('id'), values: { title: 'updated' } });
    const updated = await Item.repository.findOne({ filterByTk: created.get('id') });
    expect(updated.get('title')).toBe('updated');

    await Item.repository.destroy({ filterByTk: created.get('id') });
    const deleted = await Item.repository.findOne({ filterByTk: created.get('id') });
    expect(deleted).toBeNull();
  });
});

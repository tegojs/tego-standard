import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import WorkflowPlugin from '../../../../../module-workflow/src/server';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import type { AccessCollectionIdentity } from '../../access-control/config-store';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreFactoryEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreFactoryEntry)('authenticated ordinary omni trigger boundary', () => {
  let app: MockServer;
  let plugin: WorkflowPlugin;
  let identity: AccessCollectionIdentity;
  let token: string;
  let userId: number;
  let workflow;
  let unregister: () => void;
  const selectedKeys = new Set<string>();
  const role = 'omni-trigger-business-member';
  const password = 'omni-trigger-boundary-password';
  const collectionName = 'omniTriggerEmptyDocuments';
  const agent = () =>
    app
      .agent()
      .set('Authorization', `Bearer ${token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', role)
      .set('X-Tenant-Id', 'B');

  beforeAll(async () => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreFactoryEntry!).href);
    app = await createTenantApp({
      aclFactory: createACL,
      database: { dialect: 'sqlite', storage: ':memory:' },
      extraPlugins: ['workflow'],
    });
    plugin = app.pm.get('workflow') as WorkflowPlugin;
    expect(app.resourcer.getRegisteredHandler('trigger')).toEqual(expect.any(Function));
    await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
    await app.db.getRepository('roles').create({
      values: { name: role, strategy: { actions: ['view'] }, snippets: [] },
    });
    const user = await app.db.getRepository('users').create({
      values: { username: role, password, roles: [role], tenants: ['B'], defaultTenantId: 'B' },
    });
    userId = user.get('id');
    const collection = await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: collectionName,
        tenancy: 'tenantScoped',
        timestamps: false,
        createdBy: false,
        updatedBy: false,
        fields: [{ name: 'name', type: 'string' }],
      },
    });
    identity = { dataSourceKey: 'main', collectionKey: collection.get('key'), collectionName };
    await app.db.collection(accessConfigHistory).model.sync();
    const registry = new AccessMainRootResourceRegistry(app);
    await registry.store.save(identity, { ...configFor(ownerCondition), revision: 0, rules: [] }, { userId });
    const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
    unregister = adapter.register();
    registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) => registry.select(ctx, adapter, [...selectedKeys]));
    workflow = await app.db.getRepository('workflows').create({
      values: {
        title: 'Empty-table ordinary omni trigger boundary',
        type: 'general-action',
        enabled: true,
        sync: true,
        config: { collection: collectionName },
      },
    });
    await workflow.createNode({ type: 'end', config: {} });
    expect(plugin.enabledCache.get(workflow.id)?.key).toBe(workflow.key);
    const signedIn = await app
      .agent()
      .post('/auth:signIn')
      .set('X-Authenticator', 'basic')
      .send({ account: role, password });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.data.user.id).toBe(userId);
    expect(signedIn.body.data.user.hasPassword).toBe(true);
    token = signedIn.body.data.token;
    expect(token).toEqual(expect.any(String));
  });

  afterAll(async () => {
    await workflow?.update({ enabled: false });
    unregister?.();
    await app?.destroy();
  });

  it('refuses a selected root before ordinary business lookup and preserves unselected empty lookup', async () => {
    const collection = app.db.getCollection(collectionName);
    expect(await collection.model.findAll({ raw: true })).toEqual([]);
    expect(await workflow.countExecutions()).toBe(0);
    const findOne = vi.spyOn(collection.repository, 'findOne');
    const find = vi.spyOn(collection.repository, 'find');
    const request = () => agent().resource(collectionName).trigger({ filterByTk: 1, triggerWorkflows: workflow.key });
    try {
      selectedKeys.add(identity.collectionKey);
      const denied = await request();
      expect(denied.status).toBe(400);
      expect(denied.body.errors[0].message).toMatch(/Selected root action requires a dedicated runtime adapter/);
      expect(findOne).not.toHaveBeenCalled();
      expect(find).not.toHaveBeenCalled();
      expect(await workflow.countExecutions()).toBe(0);

      selectedKeys.clear();
      const ordinary = await request();
      expect(ordinary.status).toBe(200);
      expect(findOne).toHaveBeenCalledTimes(1);
      const options = findOne.mock.calls[0][0];
      expect(options.filterByTk).toBe('1');
      expect(options.context.state.currentUser.id).toBe(userId);
      expect(options.context.state.currentRole).toBe(role);
      expect(options.context.state.currentTenantId).toBe('B');
      expect(await workflow.countExecutions()).toBe(0);
      expect(await collection.model.findAll({ raw: true })).toEqual([]);
    } finally {
      findOne.mockRestore();
      find.mockRestore();
      selectedKeys.clear();
    }
  });
});

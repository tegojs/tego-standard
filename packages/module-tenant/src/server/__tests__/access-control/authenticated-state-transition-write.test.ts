import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated state transitions out of an editing scope', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
  });

  // Rechecking the old scope after SQL would turn a valid submission into an error or rollback.
  // SQL 后重查旧编辑范围会把合法提交变成错误或回滚；只按新输入检查则会错误允许重开。
  it.each(['G', 'role scope'] as const)('commits a draft submission that leaves its former %s', async (boundary) => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
    app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
    await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
    const role = 'draft-task-editor';
    const password = 'state-transition-test-password';
    await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
    const user = await app.db.getRepository('users').create({
      values: { username: role, password, roles: [role], tenants: ['B'], defaultTenantId: 'B' },
    });
    const collectionName = 'stateTransitionTasks';
    const stored = await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: collectionName,
        tenancy: 'tenantScoped',
        timestamps: false,
        createdBy: false,
        updatedBy: false,
        fields: [
          { name: 'name', type: 'string' },
          { name: 'stage', type: 'string' },
        ],
      },
    });
    const scope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
      values: {
        dataSourceKey: 'main',
        name: 'Draft tasks',
        resourceName: collectionName,
        scope: { stage: { $eq: 'draft' } },
      },
    });
    const resource = await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: role,
        name: collectionName,
        usingActionsConfig: true,
        actions: [
          { name: 'create', fields: ['name', 'stage'] },
          {
            name: 'update',
            fields: ['name', 'stage'],
            scope: boundary === 'role scope' ? { id: scope.get('id') } : null,
          },
        ],
      },
    });
    const actions = await resource.getActions({ include: ['scope'] });
    expect(
      actions
        .map((action) => ({
          name: action.get('name'),
          fields: [...action.get('fields')].sort(),
          filter: action.get('scope')?.get('scope') ?? null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ).toEqual([
      { name: 'create', fields: ['name', 'stage'], filter: null },
      {
        name: 'update',
        fields: ['name', 'stage'],
        filter: boundary === 'role scope' ? { stage: { $eq: 'draft' } } : null,
      },
    ]);
    const registry = new AccessMainRootResourceRegistry(app);
    const identity = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName };
    await app.db.collection(accessConfigHistory).model.sync();
    const config = configFor({
      type: 'all',
      children: [
        ownerCondition,
        {
          type: 'compare',
          operator: 'eq',
          left: { type: 'context', path: 'user.id' },
          right: { type: 'literal', value: String(user.get('id')) },
        },
        {
          type: 'compare',
          operator: 'eq',
          left: { type: 'context', path: 'role.name' },
          right: { type: 'literal', value: role },
        },
        ...(boundary === 'G'
          ? [
              {
                type: 'compare' as const,
                operator: 'eq' as const,
                left: { type: 'field' as const, path: 'stage' },
                right: { type: 'literal' as const, value: 'draft' },
              },
            ]
          : []),
      ],
    });
    await registry.store.save(identity, { ...config, revision: 0 }, { userId: user.get('id') });
    const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
    unregister = adapter.register();
    registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
      registry.select(ctx, adapter, [identity.collectionKey]),
    );
    const signedIn = await app
      .agent()
      .post('/auth:signIn')
      .set('X-Authenticator', 'basic')
      .send({ account: role, password });
    expect(signedIn.status).toBe(200);
    expect(String(signedIn.body.data.user.id)).toBe(String(user.get('id')));
    expect(signedIn.body.data.user.hasPassword).toBe(true);
    expect(signedIn.body.data.token).toEqual(expect.any(String));
    const agent = () =>
      app
        .agent()
        .set('Authorization', `Bearer ${signedIn.body.data.token}`)
        .set('X-Authenticator', 'basic')
        .set('X-Role', role)
        .set('X-Tenant-Id', 'B');
    const checked = await agent().get('/auth:check');
    expect(checked.status).toBe(200);
    expect(String(checked.body.data.id)).toBe(String(user.get('id')));
    const rows = () => app.db.getCollection(collectionName).model.findAll({ raw: true, order: [['id', 'ASC']] });
    expect(await rows()).toEqual([]);
    const draft = await agent()
      .resource(collectionName)
      .create({ values: { name: 'Draft task', stage: 'draft' } });
    expect(draft.status).toBe(200);
    expect(await rows()).toEqual([{ id: 1, name: 'Draft task', stage: 'draft', tenantId: 'B' }]);
    const submitted = await agent()
      .resource(collectionName)
      .update({
        filterByTk: 1,
        values: { name: 'Submitted task', stage: 'submitted' },
      });
    expect(submitted.status).toBe(200);
    expect(submitted.body.data).toEqual({ keys: [1], affected: 1 });
    expect(await rows()).toEqual([{ id: 1, name: 'Submitted task', stage: 'submitted', tenantId: 'B' }]);
    // New values cannot make the already submitted row satisfy a pre-write authorization check.
    // 新输入不能使已提交的旧记录重新满足写入前授权。
    const reopen = await agent()
      .resource(collectionName)
      .update({
        filterByTk: 1,
        values: { name: 'Rejected reopen', stage: 'draft' },
      });
    expect(reopen.status).toBe(403);
    expect(reopen.body.errors[0].message).toMatch(/Record is unavailable for this mutation/);
    expect(await rows()).toEqual([{ id: 1, name: 'Submitted task', stage: 'submitted', tenantId: 'B' }]);
    const next = await agent()
      .resource(collectionName)
      .create({ values: { name: 'Next draft', stage: 'draft' } });
    expect(next.status).toBe(200);
    const edited = await agent()
      .resource(collectionName)
      .update({ filterByTk: 2, values: { name: 'Still editable' } });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toEqual({ keys: [2], affected: 1 });
    expect(await rows()).toEqual([
      { id: 1, name: 'Submitted task', stage: 'submitted', tenantId: 'B' },
      { id: 2, name: 'Still editable', stage: 'draft', tenantId: 'B' },
    ]);
  });
});

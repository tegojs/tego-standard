import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated bulk-edit all mode', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
  });

  // All mode must select through update ACL and G, rather than issuing an unscoped table update.
  // 全部模式必须按 update ACL 与 G 选中，不能直接对整张表执行更新。
  it('updates only writable drafts and rolls back the whole selected batch on a late failure', async () => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
    app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
    for (const id of ['B', 'C'])
      await app.db.getRepository('tenants').create({ values: { id, name: id, enabled: true } });
    const writer = 'bulk-all-editor';
    const reader = 'bulk-all-reader';
    const password = 'bulk-all-test-password';
    for (const name of [writer, reader])
      await app.db.getRepository('roles').create({ values: { name, strategy: { actions: [] }, snippets: [] } });
    const user = await app.db.getRepository('users').create({
      values: { username: writer, password, roles: [writer, reader], tenants: ['B', 'C'], defaultTenantId: 'B' },
    });
    const collectionName = 'bulkAllTasks';
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
        name: 'Writable drafts',
        resourceName: collectionName,
        scope: { stage: { $eq: 'draft' } },
      },
    });
    for (const roleName of [writer, reader]) {
      const resource = await app.db.getRepository('dataSourcesRolesResources').create({
        values: {
          dataSourceKey: 'main',
          roleName,
          name: collectionName,
          usingActionsConfig: true,
          actions: [
            { name: 'list', fields: ['id', 'name', 'stage', 'tenantId'] },
            ...(roleName === writer
              ? [
                  { name: 'create', fields: ['name', 'stage'] },
                  { name: 'update', fields: ['name'], scope: { id: scope.get('id') } },
                ]
              : []),
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
          .sort((left, right) => left.name.localeCompare(right.name)),
      ).toEqual(
        roleName === writer
          ? [
              { name: 'create', fields: ['name', 'stage'], filter: null },
              { name: 'list', fields: ['id', 'name', 'stage', 'tenantId'], filter: null },
              { name: 'update', fields: ['name'], filter: { stage: { $eq: 'draft' } } },
            ]
          : [{ name: 'list', fields: ['id', 'name', 'stage', 'tenantId'], filter: null }],
      );
    }
    const registry = new AccessMainRootResourceRegistry(app);
    const identity = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName };
    await app.db.collection(accessConfigHistory).model.sync();
    const config = configFor(ownerCondition);
    await registry.store.save(
      identity,
      {
        ...config,
        revision: 0,
        rules: [writer, reader].map((roleName) => ({
          ...config.rules[0],
          id: roleName,
          subject: {
            type: 'all',
            children: [
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
                right: { type: 'literal', value: roleName },
              },
            ],
          },
        })),
      },
      { userId: user.get('id') },
    );
    const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
    unregister = adapter.register();
    registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
      registry.select(ctx, adapter, [identity.collectionKey]),
    );
    const signedIn = await app
      .agent()
      .post('/auth:signIn')
      .set('X-Authenticator', 'basic')
      .send({ account: writer, password });
    expect(signedIn.status).toBe(200);
    expect(String(signedIn.body.data.user.id)).toBe(String(user.get('id')));
    expect(signedIn.body.data.user.hasPassword).toBe(true);
    expect(signedIn.body.data.token).toEqual(expect.any(String));
    const agent = (tenantId = 'B', roleName = writer) =>
      app
        .agent()
        .set('Authorization', `Bearer ${signedIn.body.data.token}`)
        .set('X-Authenticator', 'basic')
        .set('X-Role', roleName)
        .set('X-Tenant-Id', tenantId);
    const checked = await agent().get('/auth:check');
    expect(checked.status).toBe(200);
    expect(String(checked.body.data.id)).toBe(String(user.get('id')));
    const model = app.db.getCollection(collectionName).model;
    const rows = () => model.findAll({ raw: true, order: [['id', 'ASC']] });
    expect(await rows()).toEqual([]);
    for (const [tenantId, name, stage] of [
      ['B', 'First draft', 'draft'],
      ['B', 'Second draft', 'draft'],
      ['B', 'Submitted task', 'submitted'],
      ['C', 'Other tenant draft', 'draft'],
    ]) {
      const created = await agent(tenantId).resource(collectionName).create({ values: { name, stage } });
      expect(created.status).toBe(200);
    }
    const initial = [
      { id: 1, name: 'First draft', stage: 'draft', tenantId: 'B' },
      { id: 2, name: 'Second draft', stage: 'draft', tenantId: 'B' },
      { id: 3, name: 'Submitted task', stage: 'submitted', tenantId: 'B' },
      { id: 4, name: 'Other tenant draft', stage: 'draft', tenantId: 'C' },
    ];
    expect(await rows()).toEqual(initial);
    for (const [tenantId, expected] of [
      ['B', initial.slice(0, 3)],
      ['C', initial.slice(3)],
    ] as const) {
      const listed = await agent(tenantId)
        .resource(collectionName)
        .list({ fields: ['id', 'name', 'stage', 'tenantId'], sort: ['id'] });
      expect(listed.status).toBe(200);
      expect(listed.body.data).toEqual(expected);
    }
    const denied = await agent('B', reader)
      .resource(collectionName)
      .update({ values: { name: 'Reader edit' }, forceUpdate: true });
    expect(denied.status).toBe(403);
    expect(await rows()).toEqual(initial);

    // This is the ordinary bulk-edit client's all-mode request: no locator and no filter.
    // 这是普通批量编辑客户端的全部模式请求：不传主键或筛选条件。
    const changed = await agent()
      .resource(collectionName)
      .update({ values: { name: 'Bulk edited' }, forceUpdate: true });
    expect(changed.status).toBe(200);
    expect(changed.body.data).toEqual({ keys: [1, 2], affected: 2 });
    const edited = [
      { id: 1, name: 'Bulk edited', stage: 'draft', tenantId: 'B' },
      { id: 2, name: 'Bulk edited', stage: 'draft', tenantId: 'B' },
      { id: 3, name: 'Submitted task', stage: 'submitted', tenantId: 'B' },
      { id: 4, name: 'Other tenant draft', stage: 'draft', tenantId: 'C' },
    ];
    expect(await rows()).toEqual(edited);
    const lateFailure = (record: { get(name: string): unknown }) => {
      if (record.get('id') === 2) throw new Error('Bulk all business validation failed');
    };
    app.db.on(`${collectionName}.afterUpdateWithAssociations`, lateFailure);
    try {
      const failed = await agent()
        .resource(collectionName)
        .update({ values: { name: 'Rolled back' }, forceUpdate: true });
      expect(failed.status).toBe(500);
      expect(await rows()).toEqual(edited);
    } finally {
      app.db.off(`${collectionName}.afterUpdateWithAssociations`, lateFailure);
    }
    const listed = await agent()
      .resource(collectionName)
      .list({ fields: ['id', 'name', 'stage', 'tenantId'], sort: ['id'] });
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual(edited.slice(0, 3));
  });
});

import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated has-many business filters', () => {
  // Catch row-multiplying joins and child predicates that borrow root ACL or bypass target G/V.
  // 多条匹配明细不能放大主记录及分页计数，主表权限不能替代明细自身的ACL和G/V。
  it('returns each project once when independently authorized tasks match the native filter', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    const reader = 'has-many-filter-reader';
    const parentOnly = 'has-many-parent-only';
    const projects = 'filteredBusinessProjects';
    const tasks = 'filteredBusinessTasks';
    try {
      const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
      app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
      for (const id of ['B', 'C'])
        await app.db.getRepository('tenants').create({ values: { id, name: id, enabled: true } });
      for (const name of [reader, parentOnly])
        await app.db.getRepository('roles').create({ values: { name, strategy: { actions: [] }, snippets: [] } });
      const password = 'has-many-filter-password';
      const user = await app.db.getRepository('users').create({
        values: { username: reader, password, roles: [reader, parentOnly], tenants: ['B', 'C'], defaultTenantId: 'B' },
      });
      const identities = [];
      for (const [name, fields] of [
        [projects, [{ name: 'name', type: 'string' }]],
        [
          tasks,
          [
            { name: 'name', type: 'string' },
            { name: 'stage', type: 'string' },
            { name: 'internalMemo', type: 'string' },
            { name: 'project', type: 'belongsTo', target: projects, foreignKey: 'projectId' },
          ],
        ],
      ] as const) {
        const stored = await app.db.getRepository('collections').create({
          context: {},
          values: { name, tenancy: 'tenantScoped', timestamps: false, createdBy: false, updatedBy: false, fields },
        });
        identities.push({ dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName: name });
      }
      await app.db.getRepository('fields').create({
        context: {},
        values: { name: 'tasks', type: 'hasMany', collectionName: projects, target: tasks, foreignKey: 'projectId' },
      });
      const scopeFilter = { name: { $ne: 'Ready ACL blocked' } };
      const scope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
        values: { dataSourceKey: 'main', resourceName: tasks, name: 'Filterable tasks', scope: scopeFilter },
      });
      for (const roleName of [reader, parentOnly])
        for (const name of [projects, tasks]) {
          if (roleName === parentOnly && name === tasks) continue;
          const fields =
            name === projects ? ['id', 'name', 'tasks', 'tenantId'] : ['id', 'name', 'projectId', 'stage', 'tenantId'];
          const actions = [
            { name: 'list', fields, ...(name === tasks ? { scope: { id: scope.get('id') } } : {}) },
            ...(name === projects ? [{ name: 'get', fields }] : []),
            ...(roleName === reader
              ? [
                  {
                    name: 'create',
                    fields: name === projects ? ['name'] : ['internalMemo', 'name', 'projectId', 'stage'],
                  },
                ]
              : []),
          ].sort((a, b) => a.name.localeCompare(b.name));
          const resource = await app.db.getRepository('dataSourcesRolesResources').create({
            values: { dataSourceKey: 'main', roleName, name, usingActionsConfig: true, actions },
          });
          expect(
            (await resource.getActions({ include: ['scope'] }))
              .map((action) => ({
                name: action.get('name'),
                fields: [...action.get('fields')].sort(),
                scopeId: action.get('scope')?.get('id') ?? null,
                filter: action.get('scope')?.get('scope') ?? null,
              }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          ).toEqual(
            actions.map((action) => ({
              name: action.name,
              fields: action.fields,
              scopeId: name === tasks && action.name === 'list' ? scope.get('id') : null,
              filter: name === tasks && action.name === 'list' ? scopeFilter : null,
            })),
          );
        }
      const login = await app
        .agent()
        .post('/auth:signIn')
        .set('X-Authenticator', 'basic')
        .send({ account: reader, password });
      expect(login.status).toBe(200);
      expect(login.body.data.user).toMatchObject({ id: user.id, hasPassword: true });
      const agent = (role = reader, tenant = 'B') =>
        app
          .agent()
          .set('Authorization', 'Bearer ' + login.body.data.token)
          .set('X-Authenticator', 'basic')
          .set('X-Role', role)
          .set('X-Tenant-Id', tenant);
      const checked = await agent().get('/auth:check');
      expect(checked.status).toBe(200);
      expect(checked.body.data).toMatchObject({ id: user.id, hasPassword: true });
      const rows = (name: string) => app.db.getCollection(name).model.findAll({ raw: true, order: [['id', 'ASC']] });
      expect(await rows(projects)).toEqual([]);
      expect(await rows(tasks)).toEqual([]);
      const expectedProjects = [
        { id: 1, name: 'Two matching tasks', tenantId: 'B' },
        { id: 2, name: 'One matching task', tenantId: 'B' },
        { id: 3, name: 'Only hidden matching tasks', tenantId: 'B' },
        { id: 4, name: 'No tasks', tenantId: 'B' },
        { id: 5, name: 'Other tenant project', tenantId: 'C' },
      ];
      const expectedTasks = [
        { id: 1, name: 'Ready draft', projectId: 1, stage: 'draft', internalMemo: 'memo1', tenantId: 'B' },
        { id: 2, name: 'Ready published', projectId: 1, stage: 'published', internalMemo: 'memo2', tenantId: 'B' },
        { id: 3, name: 'Ready second', projectId: 2, stage: 'published', internalMemo: 'memo3', tenantId: 'B' },
        { id: 4, name: 'Ready archived', projectId: 3, stage: 'archived', internalMemo: 'memo4', tenantId: 'B' },
        { id: 5, name: 'Ready ACL blocked', projectId: 3, stage: 'draft', internalMemo: 'memo5', tenantId: 'B' },
        { id: 6, name: 'Ready other tenant', projectId: 5, stage: 'draft', internalMemo: 'memo6', tenantId: 'C' },
        { id: 7, name: 'Not matching', projectId: 2, stage: 'draft', internalMemo: 'memo7', tenantId: 'B' },
      ];
      // Original authenticated writers establish known harmless links before selecting either reader.
      // 原认证写入口仅建立已知无害关联，不冒称选中关联写或并发隔离验收。
      for (const row of expectedProjects)
        expect(
          (
            await agent(reader, row.tenantId)
              .resource(projects)
              .create({ values: { name: row.name } })
          ).status,
        ).toBe(200);
      for (const row of expectedTasks)
        expect(
          (
            await agent(reader, row.tenantId)
              .resource(tasks)
              .create({
                values: {
                  name: row.name,
                  projectId: row.projectId,
                  stage: row.stage,
                  internalMemo: row.internalMemo,
                },
              })
          ).status,
        ).toBe(200);
      expect(await rows(projects)).toEqual(expectedProjects);
      expect(await rows(tasks)).toEqual(expectedTasks);
      const registry = new AccessMainRootResourceRegistry(app);
      await app.db.collection(accessConfigHistory).model.sync();
      const stageCondition = (stage: string) => ({
        type: 'all' as const,
        children: [
          ownerCondition,
          {
            type: 'compare' as const,
            operator: 'eq' as const,
            left: { type: 'field' as const, path: 'stage' },
            right: { type: 'literal' as const, value: stage },
          },
        ],
      });
      for (const identity of identities) {
        const config = configFor(identity.collectionName === tasks ? stageCondition('draft') : ownerCondition);
        if (identity.collectionName === tasks)
          config.rules.push({
            ...configFor(stageCondition('published'), 'visibility').rules[0],
            id: 'published-task-visible',
          });
        for (const rule of config.rules)
          rule.subject = {
            type: 'all',
            children: [
              {
                type: 'compare',
                operator: 'eq',
                left: { type: 'context', path: 'user.id' },
                right: { type: 'literal', value: String(user.id) },
              },
              {
                type: 'compare',
                operator: 'in',
                left: { type: 'context', path: 'role.name' },
                right: { type: 'literal', value: [reader, parentOnly] },
              },
            ],
          };
        await registry.store.save(identity, { ...config, revision: 0 }, { userId: user.id });
      }
      const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
      unregister = adapter.register();
      registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
        registry.select(
          ctx,
          adapter,
          identities.map((identity) => identity.collectionKey),
        ),
      );
      const fields = ['id', 'name', 'tenantId'];
      const scalar = await agent()
        .resource(projects)
        .list({ fields, sort: ['id'] });
      expect(scalar.status).toBe(200);
      expect(scalar.body.data).toEqual(expectedProjects.slice(0, 4));
      const visibleTasks = await agent()
        .resource(tasks)
        .list({ fields: ['id', 'name', 'projectId', 'stage', 'tenantId'], sort: ['id'] });
      expect(visibleTasks.status).toBe(200);
      expect(visibleTasks.body.data).toEqual([
        { id: 1, name: 'Ready draft', projectId: 1, stage: 'draft', tenantId: 'B' },
        { id: 2, name: 'Ready published', projectId: 1, stage: 'published', tenantId: 'B' },
        { id: 3, name: 'Ready second', projectId: 2, stage: 'published', tenantId: 'B' },
        { id: 7, name: 'Not matching', projectId: 2, stage: 'draft', tenantId: 'B' },
      ]);
      const filter = { $and: [{ 'tasks.name': { $includes: 'Ready' } }] };
      const filtered = await agent()
        .resource(projects)
        .list({ fields, filter, sort: ['id'] });
      expect(filtered.status).toBe(200);
      expect(filtered.body.data).toEqual([expectedProjects[0], expectedProjects[1]]);
      expect(filtered.body.meta.count).toBe(2);
      for (const [page, expected] of [
        [1, expectedProjects[0]],
        [2, expectedProjects[1]],
      ] as const) {
        const result = await agent()
          .resource(projects)
          .list({ fields, filter, sort: ['id'], page, pageSize: 1 });
        expect(result.status).toBe(200);
        expect(result.body.data).toEqual([expected]);
        expect(result.body.meta.count).toBe(2);
      }
      const detail = await agent().resource(projects).get({ filterByTk: 1, fields, filter });
      expect(detail.status).toBe(200);
      expect(detail.body.data).toEqual(expectedProjects[0]);
      const hidden = await agent().resource(projects).get({ filterByTk: 3, fields, filter });
      expect(hidden.status).toBe(200);
      expect(hidden.body.data).toBeNull();
      const forbidden = await agent()
        .resource(projects)
        .list({ fields, filter: { 'tasks.internalMemo': 'memo1' } });
      expect(forbidden.status).toBe(400);
      expect(forbidden.body.data).toBeUndefined();
      const parentScalar = await agent(parentOnly)
        .resource(projects)
        .list({ fields, sort: ['id'] });
      expect(parentScalar.status).toBe(200);
      expect(parentScalar.body.data).toEqual(expectedProjects.slice(0, 4));
      const denied = await agent(parentOnly).resource(projects).list({ fields, filter });
      expect(denied.status).toBe(403);
      expect(denied.body.data).toBeUndefined();
      expect(await rows(projects)).toEqual(expectedProjects);
      expect(await rows(tasks)).toEqual(expectedTasks);
    } finally {
      unregister?.();
      await app?.destroy();
    }
  });
});

import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated related business queries', () => {
  // Catch hidden project values influencing task order/predicates or root grants replacing target ACL.
  // 隐藏项目不能影响任务排序或筛选，任务授权也不能替代项目动作及字段ACL。
  it('filters and orders ordinary task lists by independently authorized project fields', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    const reader = 'related-business-reader';
    const taskOnly = 'related-task-only';
    const projects = 'queryBusinessProjects';
    const tasks = 'queryBusinessTasks';
    try {
      const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
      app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
      for (const id of ['B', 'C'])
        await app.db.getRepository('tenants').create({ values: { id, name: id, enabled: true } });
      for (const name of [reader, taskOnly])
        await app.db.getRepository('roles').create({ values: { name, strategy: { actions: [] }, snippets: [] } });
      const password = 'related-business-password';
      const user = await app.db.getRepository('users').create({
        values: { username: reader, password, roles: [reader, taskOnly], tenants: ['B', 'C'], defaultTenantId: 'B' },
      });
      const identities = [];
      for (const [name, fields] of [
        [
          projects,
          [
            { name: 'name', type: 'string' },
            { name: 'stage', type: 'string' },
            { name: 'internalMemo', type: 'string' },
          ],
        ],
        [
          tasks,
          [
            { name: 'name', type: 'string' },
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
      const projectFields = ['id', 'name', 'stage', 'tenantId'];
      const taskFields = ['id', 'name', 'project', 'projectId', 'tenantId'];
      const scopeFilter = { name: { $ne: 'Atlas' } };
      const scope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
        values: { dataSourceKey: 'main', resourceName: projects, name: 'Queryable projects', scope: scopeFilter },
      });
      for (const roleName of [reader, taskOnly])
        for (const name of [projects, tasks]) {
          if (roleName === taskOnly && name === projects) continue;
          const fields = name === projects ? projectFields : taskFields;
          const actions = [
            { name: 'list', fields, ...(name === projects ? { scope: { id: scope.get('id') } } : {}) },
            ...(name === tasks ? [{ name: 'get', fields }] : []),
            ...(roleName === reader
              ? [
                  {
                    name: 'create',
                    fields: name === projects ? ['internalMemo', 'name', 'stage'] : ['name', 'projectId'],
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
              scopeId: name === projects && action.name === 'list' ? scope.get('id') : null,
              filter: name === projects && action.name === 'list' ? scopeFilter : null,
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
        { id: 1, name: 'Zebra', stage: 'draft', internalMemo: 'memo1', tenantId: 'B' },
        { id: 2, name: 'Alpha', stage: 'published', internalMemo: 'memo2', tenantId: 'B' },
        { id: 3, name: 'Aardvark', stage: 'archived', internalMemo: 'memo3', tenantId: 'B' },
        { id: 4, name: 'AAA other tenant', stage: 'draft', internalMemo: 'memo4', tenantId: 'C' },
        { id: 5, name: 'Atlas', stage: 'draft', internalMemo: 'memo5', tenantId: 'B' },
      ];
      const expectedTasks = [
        { id: 1, name: 'Zebra task', projectId: 1, tenantId: 'B' },
        { id: 2, name: 'Alpha task', projectId: 2, tenantId: 'B' },
        { id: 3, name: 'Archived project task', projectId: 3, tenantId: 'B' },
        { id: 4, name: 'ACL blocked project task', projectId: 5, tenantId: 'B' },
        { id: 5, name: 'Unassigned task', projectId: null, tenantId: 'B' },
        { id: 6, name: 'Other tenant task', projectId: 4, tenantId: 'C' },
      ];
      // Original authenticated writers establish only known harmless links before selecting either reader.
      // 原认证写入口仅建立本人已知无害关联，不冒称选中关联写或并发隔离验收。
      for (const row of expectedProjects)
        expect(
          (
            await agent(reader, row.tenantId)
              .resource(projects)
              .create({ values: { name: row.name, stage: row.stage, internalMemo: row.internalMemo } })
          ).status,
        ).toBe(200);
      for (const row of expectedTasks)
        expect(
          (
            await agent(reader, row.tenantId)
              .resource(tasks)
              .create({ values: { name: row.name, projectId: row.projectId } })
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
        const config = configFor(identity.collectionName === projects ? stageCondition('draft') : ownerCondition);
        if (identity.collectionName === projects)
          config.rules.push({
            ...configFor(stageCondition('published'), 'visibility').rules[0],
            id: 'published-project-visible',
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
                right: { type: 'literal', value: [reader, taskOnly] },
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
      const fields = ['id', 'name', 'projectId', 'tenantId'];
      const scalar = await agent()
        .resource(tasks)
        .list({ fields, sort: ['id'] });
      expect(scalar.status).toBe(200);
      expect(scalar.body.data).toEqual(expectedTasks.slice(0, 5));
      const visibleProjects = await agent()
        .resource(projects)
        .list({ fields: projectFields, sort: ['id'] });
      expect(visibleProjects.status).toBe(200);
      expect(visibleProjects.body.data).toEqual([
        { id: 1, name: 'Zebra', stage: 'draft', tenantId: 'B' },
        { id: 2, name: 'Alpha', stage: 'published', tenantId: 'B' },
      ]);
      const sorted = await agent()
        .resource(tasks)
        .list({ fields, sort: ['project.name', 'id'] });
      expect(sorted.status).toBe(200);
      expect(sorted.body.data).toEqual([
        expectedTasks[1],
        expectedTasks[0],
        expectedTasks[2],
        expectedTasks[3],
        expectedTasks[4],
      ]);
      expect(sorted.body.meta.count).toBe(5);
      const page = await agent()
        .resource(tasks)
        .list({ fields, sort: ['project.name', 'id'], page: 2, pageSize: 2 });
      expect(page.status).toBe(200);
      expect(page.body.data).toEqual([expectedTasks[2], expectedTasks[3]]);
      expect(page.body.meta.count).toBe(5);
      const filter = { project: { name: { $includes: 'a' } } };
      const filtered = await agent()
        .resource(tasks)
        .list({ fields, sort: ['project.name', 'id'], filter });
      expect(filtered.status).toBe(200);
      expect(filtered.body.data).toEqual([expectedTasks[1], expectedTasks[0]]);
      expect(filtered.body.meta.count).toBe(2);
      const detail = await agent().resource(tasks).get({ filterByTk: 1, fields, filter });
      expect(detail.status).toBe(200);
      expect(detail.body.data).toEqual(expectedTasks[0]);
      const hidden = await agent()
        .resource(tasks)
        .get({ filterByTk: 3, fields, filter: { 'project.name': 'Aardvark' } });
      expect(hidden.status).toBe(200);
      expect(hidden.body.data).toBeNull();
      const forbidden = await agent()
        .resource(tasks)
        .list({ fields, sort: ['project.internalMemo'] });
      expect(forbidden.status).toBe(400);
      expect(forbidden.body.data).toBeUndefined();
      const taskScalar = await agent(taskOnly)
        .resource(tasks)
        .list({ fields, sort: ['id'] });
      expect(taskScalar.status).toBe(200);
      expect(taskScalar.body.data).toEqual(expectedTasks.slice(0, 5));
      for (const query of [
        { fields, sort: ['project.name'] },
        { fields, filter },
      ]) {
        const denied = await agent(taskOnly).resource(tasks).list(query);
        expect(denied.status).toBe(403);
        expect(denied.body.data).toBeUndefined();
      }
      expect(await rows(projects)).toEqual(expectedProjects);
      expect(await rows(tasks)).toEqual(expectedTasks);
    } finally {
      unregister?.();
      await app?.destroy();
    }
  });
});

import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated expanded business reads', () => {
  // Catch parent-grant substitution, unfiltered/default-field child reads, and off-page relation mixing.
  // 项目可读不能替代明细授权，默认展开须过滤明细行和字段，并保持当前项目及分页边界。
  it('expands task rows using independent target scope and field ACL in ordinary project list/get', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    const reader = 'expanded-project-reader';
    const parentOnly = 'expanded-parent-only';
    const projects = 'expandedBusinessProjects';
    const tasks = 'expandedBusinessTasks';
    try {
      const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
      app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
      await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
      for (const name of [reader, parentOnly])
        await app.db.getRepository('roles').create({ values: { name, strategy: { actions: [] }, snippets: [] } });
      const password = 'expanded-business-password';
      const user = await app.db.getRepository('users').create({
        values: { username: reader, password, roles: [reader, parentOnly], tenants: ['B'], defaultTenantId: 'B' },
      });
      const sources = [];
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
        sources.push({ dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName: name });
      }
      await app.db.getRepository('fields').create({
        context: {},
        values: { name: 'tasks', type: 'hasMany', collectionName: projects, target: tasks, foreignKey: 'projectId' },
      });
      for (const roleName of [reader, parentOnly]) {
        for (const name of [projects, tasks]) {
          if (roleName === parentOnly && name === tasks) continue;
          const fields =
            name === projects ? ['id', 'name', 'tasks', 'tenantId'] : ['id', 'name', 'projectId', 'stage', 'tenantId'];
          const actions = [
            { name: 'view', fields },
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
            (await resource.getActions())
              .map((action) => ({ name: action.get('name'), fields: [...action.get('fields')].sort() }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          ).toEqual(actions);
        }
      }
      const login = await app
        .agent()
        .post('/auth:signIn')
        .set('X-Authenticator', 'basic')
        .send({ account: reader, password });
      expect(login.status).toBe(200);
      expect(login.body.data.user).toMatchObject({ id: user.id, hasPassword: true });
      const agent = (role = reader) =>
        app
          .agent()
          .set('Authorization', 'Bearer ' + login.body.data.token)
          .set('X-Authenticator', 'basic')
          .set('X-Role', role)
          .set('X-Tenant-Id', 'B');
      const checked = await agent().get('/auth:check');
      expect(checked.status).toBe(200);
      expect(checked.body.data).toMatchObject({ id: user.id, hasPassword: true });
      const rows = (name: string) => app.db.getCollection(name).model.findAll({ raw: true, order: [['id', 'ASC']] });
      expect(await rows(projects)).toEqual([]);
      expect(await rows(tasks)).toEqual([]);
      // Establish harmless links through the original HTTP writer; this does not exercise selected relational writes.
      // 原HTTP写入口仅建立无害关联基线，不冒称SQLite选中关联写验收。
      for (const name of ['First project', 'Second project'])
        expect((await agent().resource(projects).create({ values: { name } })).status).toBe(200);
      for (const values of [
        { name: 'Draft task', stage: 'draft', internalMemo: 'memo1', projectId: 1 },
        { name: 'Published task', stage: 'published', internalMemo: 'memo2', projectId: 1 },
        { name: 'Archived task', stage: 'archived', internalMemo: 'memo3', projectId: 1 },
        { name: 'Other project task', stage: 'draft', internalMemo: 'memo4', projectId: 2 },
      ])
        expect((await agent().resource(tasks).create({ values })).status).toBe(200);
      const expectedProjects = [
        { id: 1, name: 'First project', tenantId: 'B' },
        { id: 2, name: 'Second project', tenantId: 'B' },
      ];
      const expectedTasks = [
        { id: 1, name: 'Draft task', stage: 'draft', internalMemo: 'memo1', projectId: 1, tenantId: 'B' },
        { id: 2, name: 'Published task', stage: 'published', internalMemo: 'memo2', projectId: 1, tenantId: 'B' },
        { id: 3, name: 'Archived task', stage: 'archived', internalMemo: 'memo3', projectId: 1, tenantId: 'B' },
        { id: 4, name: 'Other project task', stage: 'draft', internalMemo: 'memo4', projectId: 2, tenantId: 'B' },
      ];
      expect(await rows(projects)).toEqual(expectedProjects);
      expect(await rows(tasks)).toEqual(expectedTasks);
      const registry = new AccessMainRootResourceRegistry(app);
      await app.db.collection(accessConfigHistory).model.sync();
      for (const source of sources) {
        const config = configFor(
          source.collectionName === projects
            ? ownerCondition
            : {
                type: 'all',
                children: [
                  ownerCondition,
                  {
                    type: 'compare',
                    operator: 'eq',
                    left: { type: 'field', path: 'stage' },
                    right: { type: 'literal', value: 'draft' },
                  },
                ],
              },
        );
        if (source.collectionName === tasks)
          config.rules.push({
            ...configFor(
              {
                type: 'all',
                children: [
                  ownerCondition,
                  {
                    type: 'compare',
                    operator: 'eq',
                    left: { type: 'field', path: 'stage' },
                    right: { type: 'literal', value: 'published' },
                  },
                ],
              },
              'visibility',
            ).rules[0],
            id: 'published-visible',
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
        await registry.store.save(source, { ...config, revision: 0 }, { userId: user.id });
      }
      const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
      unregister = adapter.register();
      registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
        registry.select(
          ctx,
          adapter,
          sources.map((source) => source.collectionKey),
        ),
      );
      const visibleTasks = [
        { id: 1, name: 'Draft task', stage: 'draft', projectId: 1, tenantId: 'B' },
        { id: 2, name: 'Published task', stage: 'published', projectId: 1, tenantId: 'B' },
        { id: 4, name: 'Other project task', stage: 'draft', projectId: 2, tenantId: 'B' },
      ];
      const direct = await agent()
        .resource(tasks)
        .list({ sort: ['id'] });
      expect(direct.status).toBe(200);
      expect(direct.body.data).toEqual(visibleTasks);
      const expanded = [
        { ...expectedProjects[0], tasks: [visibleTasks[0], visibleTasks[1]] },
        { ...expectedProjects[1], tasks: [visibleTasks[2]] },
      ];
      const listed = await agent()
        .resource(projects)
        .list({ sort: ['id'], appends: ['tasks'] });
      expect(listed.status).toBe(200);
      expect(listed.body.data).toEqual(expanded);
      expect(listed.body.meta.count).toBe(2);
      const detail = await agent()
        .resource(projects)
        .get({ filterByTk: 1, appends: ['tasks'] });
      expect(detail.status).toBe(200);
      expect(detail.body.data).toEqual(expanded[0]);
      const page = await agent()
        .resource(projects)
        .list({ sort: ['id'], page: 2, pageSize: 1, appends: ['tasks'] });
      expect(page.status).toBe(200);
      expect(page.body.data).toEqual([expanded[1]]);
      expect(page.body.meta.count).toBe(2);
      const forbiddenField = await agent()
        .resource(projects)
        .get({ filterByTk: 1, appends: ['tasks.internalMemo'] });
      expect(forbiddenField.status).toBe(400);
      expect(forbiddenField.body).not.toHaveProperty('data');
      const scalar = await agent(parentOnly)
        .resource(projects)
        .list({ sort: ['id'] });
      expect(scalar.status).toBe(200);
      expect(scalar.body.data).toEqual(expectedProjects);
      const denied = await agent(parentOnly)
        .resource(projects)
        .list({ appends: ['tasks'] });
      expect(denied.status).toBe(403);
      expect(denied.body).not.toHaveProperty('data');
      expect(await rows(projects)).toEqual(expectedProjects);
      expect(await rows(tasks)).toEqual(expectedTasks);
    } finally {
      unregister?.();
      await app?.destroy();
    }
  });
});

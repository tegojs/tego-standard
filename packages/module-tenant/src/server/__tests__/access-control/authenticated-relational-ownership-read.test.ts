import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated relation-driven task reads', () => {
  // Catch stale relationship facts, uncorrelated EXISTS, another assignee's grant, and lost independent V.
  // 关联事实必须实时读取并关联到当前任务及真实用户，独立可见性规则仍须生效。
  it('refreshes task visibility after ordinary assignment updates without changing ACL or rules', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    const roleName = 'relational-task-reader';
    const tasks = 'relationalReadTasks';
    const assignments = 'relationalReadAssignments';
    try {
      const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
      app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
      await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
      await app.db
        .getRepository('roles')
        .create({ values: { name: roleName, strategy: { actions: [] }, snippets: [] } });
      const password = 'relational-reader-password';
      const user = await app.db.getRepository('users').create({
        values: { username: roleName, password, roles: [roleName], tenants: ['B'], defaultTenantId: 'B' },
      });
      const otherUser = await app.db.getRepository('users').create({
        values: { username: 'other-task-assignee', roles: [roleName], tenants: ['B'], defaultTenantId: 'B' },
      });
      const sources = [];
      const definitions = [
        [
          tasks,
          [
            { name: 'name', type: 'string' },
            { name: 'stage', type: 'string' },
          ],
          ['id', 'name', 'stage', 'tenantId'],
          ['name', 'stage'],
          [],
        ],
        [
          assignments,
          [
            { name: 'assigneeId', type: 'string' },
            { name: 'state', type: 'string' },
            { name: 'task', type: 'belongsTo', target: tasks, foreignKey: 'taskId' },
          ],
          ['assigneeId', 'id', 'state', 'taskId', 'tenantId'],
          ['assigneeId', 'state', 'taskId'],
          ['state'],
        ],
      ] as const;
      for (const [name, fields] of definitions) {
        const stored = await app.db.getRepository('collections').create({
          context: {},
          values: { name, tenancy: 'tenantScoped', timestamps: false, createdBy: false, updatedBy: false, fields },
        });
        sources.push({ dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName: name });
      }
      await app.db.getRepository('fields').create({
        context: {},
        values: {
          name: 'assignments',
          type: 'hasMany',
          collectionName: tasks,
          target: assignments,
          foreignKey: 'taskId',
        },
      });
      for (const [name, , readFields, createFields, updateFields] of definitions) {
        const actions = [
          { name: 'view', fields: [...readFields] },
          { name: 'create', fields: [...createFields] },
          ...(updateFields.length ? [{ name: 'update', fields: [...updateFields] }] : []),
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
      const login = await app
        .agent()
        .post('/auth:signIn')
        .set('X-Authenticator', 'basic')
        .send({ account: roleName, password });
      expect(login.status).toBe(200);
      expect(login.body.data.user).toMatchObject({ id: user.id, hasPassword: true });
      const agent = () =>
        app
          .agent()
          .set('Authorization', 'Bearer ' + login.body.data.token)
          .set('X-Authenticator', 'basic')
          .set('X-Role', roleName)
          .set('X-Tenant-Id', 'B');
      const checked = await agent().get('/auth:check');
      expect(checked.status).toBe(200);
      expect(checked.body.data).toMatchObject({ id: user.id, hasPassword: true });
      const rows = (name: string) => app.db.getCollection(name).model.findAll({ raw: true, order: [['id', 'ASC']] });
      expect(await rows(tasks)).toEqual([]);
      expect(await rows(assignments)).toEqual([]);
      // Use the original HTTP writer only to establish links; selected relational writes still require PostgreSQL.
      // 原HTTP入口仅建立无害关联基线，选中关联写的PostgreSQL门控保持不变。
      for (const values of [
        { name: 'First task', stage: 'draft' },
        { name: 'Second task', stage: 'draft' },
        { name: 'Published task', stage: 'published' },
      ])
        expect((await agent().resource(tasks).create({ values })).status).toBe(200);
      for (const values of [
        { taskId: 1, assigneeId: String(user.id), state: 'active' },
        { taskId: 2, assigneeId: String(user.id), state: 'closed' },
        { taskId: 2, assigneeId: String(otherUser.id), state: 'active' },
      ])
        expect((await agent().resource(assignments).create({ values })).status).toBe(200);
      const expectedTasks = [
        { id: 1, name: 'First task', stage: 'draft', tenantId: 'B' },
        { id: 2, name: 'Second task', stage: 'draft', tenantId: 'B' },
        { id: 3, name: 'Published task', stage: 'published', tenantId: 'B' },
      ];
      const expectedAssignments = [
        { id: 1, taskId: 1, assigneeId: String(user.id), state: 'active', tenantId: 'B' },
        { id: 2, taskId: 2, assigneeId: String(user.id), state: 'closed', tenantId: 'B' },
        { id: 3, taskId: 2, assigneeId: String(otherUser.id), state: 'active', tenantId: 'B' },
      ];
      expect(await rows(tasks)).toEqual(expectedTasks);
      expect(await rows(assignments)).toEqual(expectedAssignments);
      const registry = new AccessMainRootResourceRegistry(app);
      await app.db.collection(accessConfigHistory).model.sync();
      for (const source of sources) {
        const config = configFor(
          source.collectionName === tasks
            ? {
                type: 'all',
                children: [
                  ownerCondition,
                  {
                    type: 'exists',
                    path: 'assignments',
                    condition: {
                      type: 'all',
                      children: [
                        ownerCondition,
                        {
                          type: 'compare',
                          operator: 'eq',
                          left: { type: 'field', path: 'assigneeId' },
                          right: { type: 'context', path: 'user.id' },
                        },
                        {
                          type: 'compare',
                          operator: 'eq',
                          left: { type: 'field', path: 'state' },
                          right: { type: 'literal', value: 'active' },
                        },
                      ],
                    },
                  },
                ],
              }
            : ownerCondition,
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
                operator: 'eq',
                left: { type: 'context', path: 'role.name' },
                right: { type: 'literal', value: roleName },
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
      const initial = await agent()
        .resource(tasks)
        .list({ sort: ['id'] });
      expect(initial.status).toBe(200);
      expect(initial.body.data).toEqual([expectedTasks[0], expectedTasks[2]]);
      const hidden = await agent()
        .resource(tasks)
        .list({ filter: { id: 2 } });
      expect(hidden.status).toBe(200);
      expect(hidden.body.data).toEqual([]);
      const detail = await agent().resource(tasks).get({ filterByTk: 1 });
      expect(detail.status).toBe(200);
      expect(detail.body.data).toEqual(expectedTasks[0]);
      const closed = await agent()
        .resource(assignments)
        .update({ filterByTk: 1, values: { state: 'closed' } });
      expect(closed.status).toBe(200);
      expect(closed.body.data).toEqual({ keys: [1], affected: 1 });
      const afterClosed = [
        { ...expectedAssignments[0], state: 'closed' },
        expectedAssignments[1],
        expectedAssignments[2],
      ];
      expect(await rows(assignments)).toEqual(afterClosed);
      const removed = await agent()
        .resource(tasks)
        .list({ sort: ['id'] });
      expect(removed.status).toBe(200);
      expect(removed.body.data).toEqual([expectedTasks[2]]);
      const oldTask = await agent()
        .resource(tasks)
        .list({ filter: { id: 1 } });
      expect(oldTask.status).toBe(200);
      expect(oldTask.body.data).toEqual([]);
      const activated = await agent()
        .resource(assignments)
        .update({ filterByTk: 2, values: { state: 'active' } });
      expect(activated.status).toBe(200);
      expect(activated.body.data).toEqual({ keys: [2], affected: 1 });
      expect(await rows(assignments)).toEqual([
        afterClosed[0],
        { ...expectedAssignments[1], state: 'active' },
        expectedAssignments[2],
      ]);
      const afterActivated = await agent()
        .resource(tasks)
        .list({ sort: ['id'] });
      expect(afterActivated.status).toBe(200);
      expect(afterActivated.body.data).toEqual([expectedTasks[1], expectedTasks[2]]);
      const newDetail = await agent().resource(tasks).get({ filterByTk: 2 });
      expect(newDetail.status).toBe(200);
      expect(newDetail.body.data).toEqual(expectedTasks[1]);
      expect(await rows(tasks)).toEqual(expectedTasks);
    } finally {
      unregister?.();
      await app?.destroy();
    }
  });
});

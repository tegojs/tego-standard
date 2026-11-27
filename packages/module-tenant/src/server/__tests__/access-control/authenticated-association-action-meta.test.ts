import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated association action metadata', () => {
  // Catch source-model/source-write substitution, visibility used as ownership, and off-page target hints.
  // 来源模型或写权限不能替代目标权限，可见性不能产生写提示，提示只能含当前关联页的目标。
  it('reports the returned association targets using their own action ACL and ownership', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    const editor = 'association-meta-editor';
    const reader = 'association-meta-target-reader';
    const sourceBlocked = 'association-meta-source-blocked';
    const projects = 'actionMetaProjects';
    const tasks = 'associationMetaTasks';
    try {
      const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
      app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
      await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
      for (const name of [editor, reader, sourceBlocked])
        await app.db.getRepository('roles').create({ values: { name, strategy: { actions: [] }, snippets: [] } });
      const password = 'association-meta-password';
      const user = await app.db.getRepository('users').create({
        values: {
          username: editor,
          password,
          roles: [editor, reader, sourceBlocked],
          tenants: ['B'],
          defaultTenantId: 'B',
        },
      });
      const sources = [];
      for (const [name, fields] of [
        [projects, [{ name: 'name', type: 'string' }]],
        [
          tasks,
          [
            { name: 'name', type: 'string' },
            { name: 'stage', type: 'string' },
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
      for (const roleName of [editor, reader, sourceBlocked]) {
        for (const name of [projects, tasks]) {
          const source = name === projects;
          const writable = source || roleName !== reader;
          const fields = source
            ? ['id', 'name', 'tasks', 'tenantId']
            : ['id', 'name', 'projectId', 'stage', 'tenantId'];
          const writeFields = source ? ['name'] : ['name', 'projectId', 'stage'];
          const expected = [
            ...(!source || roleName !== sourceBlocked ? [{ name: 'view', fields, scopeId: null }] : []),
            ...(writable
              ? [
                  { name: 'create', fields: writeFields, scopeId: null },
                  { name: 'update', fields: writeFields, scopeId: null },
                  { name: 'destroy', fields: [], scopeId: null },
                ]
              : []),
          ].sort((a, b) => a.name.localeCompare(b.name));
          const resource = await app.db.getRepository('dataSourcesRolesResources').create({
            values: { dataSourceKey: 'main', roleName, name, usingActionsConfig: true, actions: expected },
          });
          expect(
            (await resource.getActions())
              .map((action) => ({
                name: action.get('name'),
                fields: [...(action.get('fields') || [])].sort(),
                scopeId: action.get('scopeId') ?? null,
              }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          ).toEqual(expected);
        }
      }
      const login = await app
        .agent()
        .post('/auth:signIn')
        .set('X-Authenticator', 'basic')
        .send({ account: editor, password });
      expect(login.status).toBe(200);
      expect(login.body.data.user).toMatchObject({ id: user.id, hasPassword: true });
      const agent = (role = editor) =>
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
      // Establish harmless relationships through the original HTTP writer before selecting the new read runtime.
      // 仅用原HTTP入口建立基线，不把SQLite关联写当作新执行器的事务验收。
      for (const name of ['Project one', 'Project two'])
        expect((await agent().resource(projects).create({ values: { name } })).status).toBe(200);
      for (const values of [
        { name: 'Other project task', stage: 'draft', projectId: 2 },
        { name: 'Editable task', stage: 'draft', projectId: 1 },
        { name: 'Task to submit', stage: 'draft', projectId: 1 },
      ])
        expect((await agent().resource(tasks).create({ values })).status).toBe(200);
      const expectedProjects = [
        { id: 1, name: 'Project one', tenantId: 'B' },
        { id: 2, name: 'Project two', tenantId: 'B' },
      ];
      expect(await rows(projects)).toEqual(expectedProjects);
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
          config.rules.push({ ...configFor(ownerCondition, 'visibility').rules[0], id: 'visible' });
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
                type: 'any',
                children: [editor, reader, sourceBlocked].map((value) => ({
                  type: 'compare',
                  operator: 'eq',
                  left: { type: 'context', path: 'role.name' },
                  right: { type: 'literal', value },
                })),
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
      const submitted = await agent()
        .resource(tasks)
        .update({ filterByTk: 3, values: { name: 'Submitted task', stage: 'submitted' } });
      expect(submitted.status).toBe(200);
      expect(submitted.body.data).toEqual({ keys: [3], affected: 1 });
      const expectedTasks = [
        { id: 1, name: 'Other project task', stage: 'draft', projectId: 2, tenantId: 'B' },
        { id: 2, name: 'Editable task', stage: 'draft', projectId: 1, tenantId: 'B' },
        { id: 3, name: 'Submitted task', stage: 'submitted', projectId: 1, tenantId: 'B' },
      ];
      expect(await rows(tasks)).toEqual(expectedTasks);
      const denied = await agent()
        .resource(tasks)
        .update({ filterByTk: 3, values: { name: 'Rejected edit' } });
      expect(denied.status).toBe(403);
      expect(await rows(tasks)).toEqual(expectedTasks);
      const listed = await agent()
        .set('X-With-ACL-Meta', 'true')
        .resource(`${projects}.tasks`, 1)
        .list({ sort: ['id'] });
      expect(listed.status).toBe(200);
      expect(listed.body.data).toEqual(expectedTasks.slice(1));
      expect(listed.body.meta.allowedActions).toEqual({ view: [2, 3], update: [2], destroy: [2] });
      const detail = await agent()
        .set('X-With-ACL-Meta', 'true')
        .resource(`${projects}.tasks`, 1)
        .get({ filterByTk: 3 });
      expect(detail.status).toBe(200);
      expect(detail.body.data).toEqual(expectedTasks[2]);
      expect(detail.body.meta.allowedActions).toEqual({ view: [3], update: [], destroy: [] });
      const page = await agent()
        .set('X-With-ACL-Meta', 'true')
        .resource(`${projects}.tasks`, 1)
        .list({ sort: ['id'], page: 1, pageSize: 1 });
      expect(page.status).toBe(200);
      expect(page.body.data).toEqual([expectedTasks[1]]);
      expect(page.body.meta.allowedActions).toEqual({ view: [2], update: [2], destroy: [2] });
      const readOnly = await agent(reader)
        .set('X-With-ACL-Meta', 'true')
        .resource(`${projects}.tasks`, 1)
        .list({ sort: ['id'] });
      expect(readOnly.status).toBe(200);
      expect(readOnly.body.data).toEqual(expectedTasks.slice(1));
      expect(readOnly.body.meta.allowedActions).toEqual({ view: [2, 3], update: [], destroy: [] });
      const blocked = await agent(sourceBlocked)
        .set('X-With-ACL-Meta', 'true')
        .resource(`${projects}.tasks`, 1)
        .list({ sort: ['id'] });
      expect(blocked.status).toBe(403);
      expect(blocked.body.data).toBeUndefined();
      expect(await rows(tasks)).toEqual(expectedTasks);
      const edited = await agent()
        .resource(tasks)
        .update({ filterByTk: 2, values: { name: 'Edited task' } });
      expect(edited.status).toBe(200);
      expect(edited.body.data).toEqual({ keys: [2], affected: 1 });
      expect(await rows(tasks)).toEqual([
        expectedTasks[0],
        { ...expectedTasks[1], name: 'Edited task' },
        expectedTasks[2],
      ]);
      expect(await rows(projects)).toEqual(expectedProjects);
    } finally {
      unregister?.();
      await app?.destroy();
    }
  });
});

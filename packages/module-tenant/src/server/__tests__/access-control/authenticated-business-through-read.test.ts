import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated business through reads', () => {
  // Catch borrowed through grants, ignored link scope, duplicate target pages and stale assignment facts.
  // 两端可读不能替代业务分配表授权，重复连接不能放大分页，状态变更须影响后续读取。
  it('reads project tags through independently authorized current assignments', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    const reader = 'business-through-reader';
    const endpointsOnly = 'business-through-endpoints-only';
    const projects = 'taggedBusinessProjects';
    const tags = 'projectBusinessTags';
    const assignments = 'projectTagAssignments';
    try {
      const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
      app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
      await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
      for (const name of [reader, endpointsOnly])
        await app.db.getRepository('roles').create({ values: { name, strategy: { actions: [] }, snippets: [] } });
      const password = 'business-through-password';
      const user = await app.db.getRepository('users').create({
        values: { username: reader, password, roles: [reader, endpointsOnly], tenants: ['B'], defaultTenantId: 'B' },
      });
      const identities = [];
      for (const [name, fields] of [
        [projects, [{ name: 'name', type: 'string' }]],
        [
          tags,
          [
            { name: 'name', type: 'string' },
            { name: 'stage', type: 'string' },
            { name: 'internalMemo', type: 'string' },
          ],
        ],
        [
          assignments,
          [
            { name: 'projectId', type: 'integer' },
            { name: 'tagId', type: 'integer' },
            { name: 'status', type: 'string' },
          ],
        ],
      ] as const) {
        const stored = await app.db.getRepository('collections').create({
          context: {},
          values: {
            name,
            tenancy: 'tenantScoped',
            timestamps: false,
            createdBy: false,
            updatedBy: false,
            fields: [
              { name: 'id', type: 'integer', primaryKey: true, autoIncrement: true, allowNull: false },
              ...fields,
            ],
          },
        });
        identities.push({ dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName: name });
      }
      await app.db.getRepository('fields').create({
        context: {},
        values: {
          collectionName: projects,
          name: 'tags',
          type: 'belongsToMany',
          target: tags,
          through: assignments,
          foreignKey: 'projectId',
          otherKey: 'tagId',
          throughUnique: false,
        },
      });
      const scopeFilter = { status: { $ne: 'blocked' } };
      const scope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
        values: { dataSourceKey: 'main', resourceName: assignments, name: 'Readable assignments', scope: scopeFilter },
      });
      for (const roleName of [reader, endpointsOnly])
        for (const name of [projects, tags, assignments]) {
          if (roleName === endpointsOnly && name === assignments) continue;
          const fields =
            name === projects
              ? ['id', 'name', 'tags', 'tenantId']
              : name === tags
                ? ['id', 'name', 'stage', 'tenantId']
                : ['id', 'projectId', 'status', 'tagId', 'tenantId'];
          const actions = [
            { name: 'view', fields, ...(name === assignments ? { scope: { id: scope.get('id') } } : {}) },
            ...(roleName === reader
              ? [
                  {
                    name: 'create',
                    fields:
                      name === projects
                        ? ['name']
                        : name === tags
                          ? ['internalMemo', 'name', 'stage']
                          : ['projectId', 'status', 'tagId'],
                  },
                ]
              : []),
            ...(name === assignments ? [{ name: 'update', fields: ['status'] }] : []),
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
              scopeId: name === assignments && action.name === 'view' ? scope.get('id') : null,
              filter: name === assignments && action.name === 'view' ? scopeFilter : null,
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
      for (const name of [projects, tags, assignments]) expect(await rows(name)).toEqual([]);
      // Original HTTP creates establish known harmless links before selecting the read runtime.
      // 原HTTP新增只建立已知无害基线，不冒称SQLite选中多对多写入验收。
      for (const name of ['First project', 'Second project'])
        expect((await agent().resource(projects).create({ values: { name } })).status).toBe(200);
      const expectedTags = [
        { id: 1, name: 'Draft tag', stage: 'draft', internalMemo: 'memo1', tenantId: 'B' },
        { id: 2, name: 'Published tag', stage: 'published', internalMemo: 'memo2', tenantId: 'B' },
        { id: 3, name: 'Archived tag', stage: 'archived', internalMemo: 'memo3', tenantId: 'B' },
        { id: 4, name: 'Inactive assignment tag', stage: 'draft', internalMemo: 'memo4', tenantId: 'B' },
        { id: 5, name: 'ACL blocked assignment tag', stage: 'draft', internalMemo: 'memo5', tenantId: 'B' },
        { id: 6, name: 'Unlinked tag', stage: 'draft', internalMemo: 'memo6', tenantId: 'B' },
        { id: 7, name: 'Other project tag', stage: 'draft', internalMemo: 'memo7', tenantId: 'B' },
      ];
      for (const { id, tenantId, ...values } of expectedTags)
        expect((await agent().resource(tags).create({ values })).status).toBe(200);
      const expectedAssignments = [
        { id: 1, projectId: 1, tagId: 1, status: 'active', tenantId: 'B' },
        { id: 2, projectId: 1, tagId: 1, status: 'active', tenantId: 'B' },
        { id: 3, projectId: 1, tagId: 2, status: 'active', tenantId: 'B' },
        { id: 4, projectId: 1, tagId: 3, status: 'active', tenantId: 'B' },
        { id: 5, projectId: 1, tagId: 4, status: 'inactive', tenantId: 'B' },
        { id: 6, projectId: 1, tagId: 5, status: 'blocked', tenantId: 'B' },
        { id: 7, projectId: 2, tagId: 7, status: 'active', tenantId: 'B' },
      ];
      for (const { id, tenantId, ...values } of expectedAssignments)
        expect((await agent().resource(assignments).create({ values })).status).toBe(200);
      const expectedProjects = [
        { id: 1, name: 'First project', tenantId: 'B' },
        { id: 2, name: 'Second project', tenantId: 'B' },
      ];
      expect(await rows(projects)).toEqual(expectedProjects);
      expect(await rows(tags)).toEqual(expectedTags);
      expect(await rows(assignments)).toEqual(expectedAssignments);
      const registry = new AccessMainRootResourceRegistry(app);
      await app.db.collection(accessConfigHistory).model.sync();
      for (const identity of identities) {
        const status = identity.collectionName === tags ? 'stage' : 'status';
        const condition = (value: string) => ({
          type: 'all' as const,
          children: [
            ownerCondition,
            {
              type: 'compare' as const,
              operator: 'eq' as const,
              left: { type: 'field' as const, path: status },
              right: { type: 'literal' as const, value },
            },
          ],
        });
        const config = configFor(
          identity.collectionName === projects
            ? ownerCondition
            : condition(identity.collectionName === tags ? 'draft' : 'active'),
        );
        if (identity.collectionName !== projects)
          config.rules.push({
            ...configFor(condition(identity.collectionName === tags ? 'published' : 'blocked'), 'visibility').rules[0],
            id: 'visible',
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
                right: { type: 'literal', value: [reader, endpointsOnly] },
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
      const visible = [
        { id: 1, name: 'Draft tag', stage: 'draft', tenantId: 'B' },
        { id: 2, name: 'Published tag', stage: 'published', tenantId: 'B' },
      ];
      const direct = await agent()
        .resource(tags)
        .list({ sort: ['id'] });
      expect(direct.status).toBe(200);
      expect(direct.body.data).toEqual([
        ...visible,
        { id: 4, name: 'Inactive assignment tag', stage: 'draft', tenantId: 'B' },
        { id: 5, name: 'ACL blocked assignment tag', stage: 'draft', tenantId: 'B' },
        { id: 6, name: 'Unlinked tag', stage: 'draft', tenantId: 'B' },
        { id: 7, name: 'Other project tag', stage: 'draft', tenantId: 'B' },
      ]);
      const linked = (project = 1, role = reader) => agent(role).resource(projects + '.tags', project);
      const listed = await linked().list({ sort: ['id'] });
      expect(listed.status).toBe(200);
      expect(listed.body.data).toEqual(visible);
      expect(listed.body.meta.count).toBe(2);
      const page = await linked().list({ sort: ['id'], page: 2, pageSize: 1 });
      expect(page.status).toBe(200);
      expect(page.body.data).toEqual([visible[1]]);
      expect(page.body.meta.count).toBe(2);
      const detail = await linked().get({ filterByTk: 2 });
      expect(detail.status).toBe(200);
      expect(detail.body.data).toEqual(visible[1]);
      const hidden = await linked().get({ filterByTk: 4 });
      expect(hidden.status).toBe(200);
      expect(hidden.body.data).toBeNull();
      const other = await linked(2).list({ sort: ['id'] });
      expect(other.status).toBe(200);
      expect(other.body.data).toEqual([{ id: 7, name: 'Other project tag', stage: 'draft', tenantId: 'B' }]);
      const endpoint = await agent(endpointsOnly)
        .resource(tags)
        .list({ sort: ['id'] });
      expect(endpoint.status).toBe(200);
      expect(endpoint.body.data).toEqual(direct.body.data);
      const denied = await linked(1, endpointsOnly).list();
      expect(denied.status).toBe(403);
      expect(denied.body).not.toHaveProperty('data');
      const changed = await agent()
        .resource(assignments)
        .update({ filterByTk: 3, values: { status: 'inactive' } });
      expect(changed.status).toBe(200);
      expect(changed.body.data).toEqual({ keys: [3], affected: 1 });
      const after = await linked().list({ sort: ['id'] });
      expect(after.status).toBe(200);
      expect(after.body.data).toEqual([visible[0]]);
      expect(after.body.meta.count).toBe(1);
      expect(await rows(projects)).toEqual(expectedProjects);
      expect(await rows(tags)).toEqual(expectedTags);
      expect(await rows(assignments)).toEqual(
        expectedAssignments.map((row) => (row.id === 3 ? { ...row, status: 'inactive' } : row)),
      );
    } finally {
      unregister?.();
      await app?.destroy();
    }
  });
});

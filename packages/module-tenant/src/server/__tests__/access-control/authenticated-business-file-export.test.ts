import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import ExportPlugin from '../../../../../plugin-action-export/src/server';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;
const xlsx = createRequire(new URL('../../../../../plugin-action-export/package.json', import.meta.url))(
  'node-xlsx',
) as {
  parse(data: Buffer): Array<{ data: unknown[][] }>;
};

describe.skipIf(!coreEntry)('authenticated ordinary business file export', () => {
  // Catch list-grant substitution, lost export filters/order, or renderer reloads exposing unselected fields.
  // 导出须用自身范围和字段权限，保留请求筛选、排序及选列，渲染不能重读越权字段。
  it('renders only requested columns from the independently authorized and ordered export rows', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    const exporter = 'business-file-exporter';
    const listOnly = 'business-file-list-only';
    const name = 'fileBusinessOrders';
    try {
      const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
      app = await createTenantApp({
        aclFactory: createACL,
        database: { dialect: 'sqlite', storage: ':memory:' },
        extraPlugins: [ExportPlugin],
      });
      for (const id of ['B', 'C'])
        await app.db.getRepository('tenants').create({ values: { id, name: id, enabled: true } });
      for (const role of [exporter, listOnly])
        await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
      const password = 'business-file-password';
      const user = await app.db.getRepository('users').create({
        values: {
          username: exporter,
          password,
          roles: [exporter, listOnly],
          tenants: ['B', 'C'],
          defaultTenantId: 'B',
        },
      });
      const stored = await app.db.getRepository('collections').create({
        context: {},
        values: {
          name,
          tenancy: 'tenantScoped',
          timestamps: false,
          createdBy: false,
          updatedBy: false,
          fields: [
            { name: 'name', type: 'string' },
            { name: 'amount', type: 'integer' },
            { name: 'stage', type: 'string' },
            { name: 'internalMemo', type: 'string' },
          ],
        },
      });
      const identity = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName: name };
      const scopeFilter = { name: { $ne: 'Export excluded' } };
      const scope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
        values: { dataSourceKey: 'main', resourceName: name, name: 'Exportable orders', scope: scopeFilter },
      });
      const listFields = ['amount', 'id', 'internalMemo', 'name', 'stage', 'tenantId'];
      const exportFields = ['amount', 'id', 'name', 'stage', 'tenantId'];
      for (const roleName of [exporter, listOnly]) {
        const actions = [
          { name: 'list', fields: listFields },
          ...(roleName === exporter
            ? [
                { name: 'export', fields: exportFields, scope: { id: scope.get('id') } },
                { name: 'create', fields: ['amount', 'internalMemo', 'name', 'stage'] },
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
            scopeId: action.name === 'export' ? scope.get('id') : null,
            filter: action.name === 'export' ? scopeFilter : null,
          })),
        );
      }
      const login = await app
        .agent()
        .post('/auth:signIn')
        .set('X-Authenticator', 'basic')
        .send({ account: exporter, password });
      expect(login.status).toBe(200);
      expect(login.body.data.user).toMatchObject({ id: user.id, hasPassword: true });
      const agent = (role = exporter, tenant = 'B') =>
        app
          .agent()
          .set('Authorization', 'Bearer ' + login.body.data.token)
          .set('X-Authenticator', 'basic')
          .set('X-Role', role)
          .set('X-Tenant-Id', tenant);
      const checked = await agent().get('/auth:check');
      expect(checked.status).toBe(200);
      expect(checked.body.data).toMatchObject({ id: user.id, hasPassword: true });
      const rows = () => app.db.getCollection(name).model.findAll({ raw: true, order: [['id', 'ASC']] });
      expect(await rows()).toEqual([]);
      const expectedRows = [
        { id: 1, name: 'First order', amount: 20, stage: 'draft', internalMemo: 'memo1', tenantId: 'B' },
        { id: 2, name: 'Published order', amount: 30, stage: 'published', internalMemo: 'memo2', tenantId: 'B' },
        { id: 3, name: 'Export excluded', amount: 1000, stage: 'draft', internalMemo: 'memo3', tenantId: 'B' },
        { id: 4, name: 'Archived order', amount: 900, stage: 'archived', internalMemo: 'memo4', tenantId: 'B' },
        { id: 5, name: 'Other tenant order', amount: 500, stage: 'draft', internalMemo: 'memo5', tenantId: 'C' },
        { id: 6, name: 'Small order', amount: 5, stage: 'draft', internalMemo: 'memo6', tenantId: 'B' },
      ];
      for (const row of expectedRows)
        expect(
          (
            await agent(exporter, row.tenantId)
              .resource(name)
              .create({
                values: {
                  name: row.name,
                  amount: row.amount,
                  stage: row.stage,
                  internalMemo: row.internalMemo,
                },
              })
          ).status,
        ).toBe(200);
      expect(await rows()).toEqual(expectedRows);
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
      const config = configFor(stageCondition('draft'));
      config.rules.push({
        ...configFor(stageCondition('published'), 'visibility').rules[0],
        id: 'published-order-visible',
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
              right: { type: 'literal', value: [exporter, listOnly] },
            },
          ],
        };
      await registry.store.save(identity, { ...config, revision: 0 }, { userId: user.id });
      const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
      unregister = adapter.register();
      registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
        registry.select(ctx, adapter, [identity.collectionKey]),
      );
      const listed = await agent()
        .resource(name)
        .list({ fields: listFields, sort: ['id'] });
      expect(listed.status).toBe(200);
      expect(listed.body.data).toEqual([expectedRows[0], expectedRows[1], expectedRows[2], expectedRows[5]]);
      const columns = [
        { dataIndex: ['name'], title: 'Order' },
        { dataIndex: ['stage'], title: 'Stage' },
        { dataIndex: ['amount'], title: 'Amount' },
      ];
      const exportFile = (selectedColumns = columns, role = exporter) =>
        agent(role)
          .resource(name)
          .export({
            title: 'Order report',
            filter: JSON.stringify({ amount: { $gte: 10 } }),
            sort: ['-amount'],
            values: { columns: selectedColumns },
          })
          .buffer(true)
          .parse((response, done) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            response.on('end', () => done(null, Buffer.concat(chunks)));
            response.on('error', done);
          });
      const file = await exportFile();
      expect(file.status).toBe(200);
      expect(file.headers['content-disposition']).toContain('Order%20report_B.xlsx');
      const sheets = xlsx.parse(file.body);
      expect(sheets).toHaveLength(1);
      expect(sheets[0].data).toEqual([
        ['Order', 'Stage', 'Amount'],
        ['Published order', 'published', 30],
        ['First order', 'draft', 20],
      ]);
      const forbidden = await exportFile([{ dataIndex: ['internalMemo'], title: 'Memo' }]);
      expect(forbidden.status).toBe(400);
      expect(forbidden.headers).not.toHaveProperty('content-disposition');
      const denied = await exportFile(columns, listOnly);
      expect(denied.status).toBe(403);
      expect(denied.headers).not.toHaveProperty('content-disposition');
      expect(await rows()).toEqual(expectedRows);
    } finally {
      unregister?.();
      await app?.destroy();
    }
  });
});

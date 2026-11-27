import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated business calendar filters', () => {
  // Catch UTC fallback at the selected terminal, lost calendar bounds, and date filters replacing G/V.
  // 选中读取不能丢失原生日历时区/边界，也不能让日期筛选替代G/V与实际租户归属。
  it('preserves the native request timezone while intersecting calendar list/get with G or V', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    const roleName = 'calendar-business-reader';
    const collectionName = 'calendarBusinessTasks';
    try {
      const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
      app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
      for (const id of ['B', 'C'])
        await app.db.getRepository('tenants').create({ values: { id, name: id, enabled: true } });
      await app.db.getRepository('roles').create({
        values: { name: roleName, strategy: { actions: [] }, snippets: [] },
      });
      const password = 'calendar-business-password';
      const user = await app.db.getRepository('users').create({
        values: { username: roleName, password, roles: [roleName], tenants: ['B', 'C'], defaultTenantId: 'B' },
      });
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
            { name: 'occurredAt', type: 'date', uiSchema: { 'x-component-props': { showTime: true } } },
          ],
        },
      });
      const fields = ['id', 'name', 'occurredAt', 'stage', 'tenantId'];
      const resource = await app.db.getRepository('dataSourcesRolesResources').create({
        values: {
          dataSourceKey: 'main',
          roleName,
          name: collectionName,
          usingActionsConfig: true,
          actions: [
            { name: 'count', fields },
            { name: 'create', fields: ['name', 'occurredAt', 'stage'] },
            { name: 'view', fields },
          ],
        },
      });
      expect(
        (await resource.getActions())
          .map((action) => ({
            name: action.get('name'),
            fields: [...action.get('fields')].sort(),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ).toEqual([
        { name: 'count', fields },
        { name: 'create', fields: ['name', 'occurredAt', 'stage'] },
        { name: 'view', fields },
      ]);
      const login = await app
        .agent()
        .post('/auth:signIn')
        .set('X-Authenticator', 'basic')
        .send({ account: roleName, password });
      expect(login.status).toBe(200);
      expect(login.body.data.user).toMatchObject({ id: user.id, hasPassword: true });
      const agent = (tenant = 'B', timezone = '+08:00') =>
        app
          .agent()
          .set('Authorization', 'Bearer ' + login.body.data.token)
          .set('X-Authenticator', 'basic')
          .set('X-Role', roleName)
          .set('X-Tenant-Id', tenant)
          .set('X-Timezone', timezone);
      const checked = await agent().get('/auth:check');
      expect(checked.status).toBe(200);
      expect(checked.body.data).toMatchObject({ id: user.id, hasPassword: true });
      const rows = async () =>
        (
          await app.db.getCollection(collectionName).model.findAll({
            raw: true,
            order: [['id', 'ASC']],
          })
        ).map((row) => ({ ...row, occurredAt: new Date(row.occurredAt).toISOString() }));
      expect(await rows()).toEqual([]);
      const expected = [
        { id: 1, name: 'Local start', occurredAt: '2026-11-11T16:00:00.000Z', stage: 'draft', tenantId: 'B' },
        { id: 2, name: 'Local end', occurredAt: '2026-11-12T15:59:59.999Z', stage: 'published', tenantId: 'B' },
        { id: 3, name: 'Before local day', occurredAt: '2026-11-11T15:59:59.999Z', stage: 'draft', tenantId: 'B' },
        { id: 4, name: 'After local day', occurredAt: '2026-11-12T16:00:00.000Z', stage: 'draft', tenantId: 'B' },
        { id: 5, name: 'Other tenant', occurredAt: '2026-11-12T04:00:00.000Z', stage: 'draft', tenantId: 'C' },
        { id: 6, name: 'Archived task', occurredAt: '2026-11-12T04:00:00.000Z', stage: 'archived', tenantId: 'B' },
      ];
      // Establish only known harmless rows through the original HTTP writer before selecting the new reader.
      // 先由原HTTP入口建立本人已知无害业务行，之后只验收选中读取。
      for (const row of expected) {
        const created = await agent(row.tenantId)
          .resource(collectionName)
          .create({
            values: { name: row.name, occurredAt: row.occurredAt, stage: row.stage },
          });
        expect(created.status).toBe(200);
      }
      expect(await rows()).toEqual(expected);
      const identity = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName };
      const registry = new AccessMainRootResourceRegistry(app);
      await app.db.collection(accessConfigHistory).model.sync();
      const config = configFor({
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
      });
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
      await registry.store.save(identity, { ...config, revision: 0 }, { userId: user.id });
      const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
      unregister = adapter.register();
      let selected = false;
      registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
        registry.select(ctx, adapter, selected ? [identity.collectionKey] : []),
      );
      const calendar = { occurredAt: { $dateOn: '2026-11-12' } };
      const legacy = await agent()
        .resource(collectionName)
        .list({ fields, sort: ['id'], filter: calendar });
      expect(legacy.status).toBe(200);
      expect(legacy.body.data).toEqual([expected[0], expected[1], expected[5]]);
      selected = true;
      const listed = await agent()
        .resource(collectionName)
        .list({ fields, sort: ['id'], filter: calendar });
      expect(listed.status).toBe(200);
      expect(listed.body.data).toEqual([expected[0], expected[1]]);
      expect(listed.body.meta.count).toBe(2);
      const nested = await agent()
        .resource(collectionName)
        .list({ fields, sort: ['id'], filter: { $and: [{ occurredAt: { $dateOn: '2026-11-12' } }] } });
      expect(nested.status).toBe(200);
      expect(nested.body.data).toEqual([expected[0], expected[1]]);
      const counted = await agent()
        .resource(collectionName)
        .count({ filter: { $and: [calendar, { id: 1 }] } });
      expect(counted.status).toBe(200);
      expect(counted.body.data).toBe(1);
      const western = await agent('B', '-08:00')
        .resource(collectionName)
        .list({ fields, sort: ['id'], filter: calendar });
      expect(western.status).toBe(200);
      expect(western.body.data).toEqual([expected[1], expected[3]]);
      const utc = await agent('B', '')
        .resource(collectionName)
        .list({ fields, sort: ['id'], filter: calendar });
      expect(utc.status).toBe(200);
      expect(utc.body.data).toEqual([expected[1], expected[3]]);
      const range = await agent()
        .resource(collectionName)
        .list({
          fields,
          sort: ['id'],
          filter: { occurredAt: { $dateBetween: ['2026-11-12', '2026-11-12'] } },
        });
      expect(range.status).toBe(200);
      expect(range.body.data).toEqual([expected[0], expected[1]]);
      const explicit = await agent('B', '-08:00')
        .resource(collectionName)
        .list({
          fields,
          sort: ['id'],
          filter: { occurredAt: { $dateOn: '2026-11-12+08:00' } },
        });
      expect(explicit.status).toBe(200);
      expect(explicit.body.data).toEqual([expected[0], expected[1]]);
      const detail = await agent().resource(collectionName).get({ filterByTk: 1, fields, filter: calendar });
      expect(detail.status).toBe(200);
      expect(detail.body.data).toEqual(expected[0]);
      const outside = await agent().resource(collectionName).get({ filterByTk: 4, fields, filter: calendar });
      expect(outside.status).toBe(200);
      expect(outside.body.data).toBeNull();
      const scalar = await agent('B', 'invalid-offset')
        .resource(collectionName)
        .list({ fields, sort: ['id'], filter: { stage: 'draft' } });
      expect(scalar.status).toBe(200);
      expect(scalar.body.data).toEqual([expected[0], expected[2], expected[3]]);
      const invalid = await agent('B', 'invalid-offset').resource(collectionName).list({ fields, filter: calendar });
      expect(invalid.status).toBe(400);
      expect(invalid.body.data).toBeUndefined();
      expect(await rows()).toEqual(expected);
    } finally {
      unregister?.();
      await app?.destroy();
    }
  });
});

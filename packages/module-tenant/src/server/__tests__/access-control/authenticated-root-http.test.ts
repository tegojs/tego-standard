import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';
import type { Model } from '@tego/server';

import ExportPlugin from '../../../../../plugin-action-export/src/server';
import DataVisualizationPlugin from '../../../../../plugin-block-charts/src/server/plugin';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import type { AccessCollectionIdentity, AccessConfigStore } from '../../access-control/config-store';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreFactoryEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;
const xlsx = createRequire(new URL('../../../../../plugin-action-export/package.json', import.meta.url))(
  'node-xlsx',
) as {
  parse(data: Buffer): Array<{ data: unknown[][] }>;
};

/** Installed auth/ACL/tenant plugins, using an explicitly selected local core ACL before plugin load. */
describe.skipIf(!coreFactoryEntry)('authenticated protected root requests', () => {
  let app: MockServer;
  let user: Model;
  let identity: AccessCollectionIdentity;
  let unconfiguredIdentity: AccessCollectionIdentity;
  let store: AccessConfigStore;
  const selectedKeys = new Set<string>();
  let unregister: (() => void) | undefined;
  const agent = (tenant = 'B', role = 'business-member') =>
    app.agent().login(user).set('X-Role', role).set('X-Tenant-Id', tenant);
  const exportFile = (tenant = 'B', role = 'business-member', collection = 'protected_documents') =>
    agent(tenant, role)
      .resource(collection)
      .export({ title: 'Access report', sort: ['id'], values: { columns: ['amount'] } })
      .buffer(true)
      .parse((response, done) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => done(null, Buffer.concat(chunks)));
        response.on('error', done);
      });
  const chart = (
    tenant = 'B',
    role = 'business-member',
    collection = 'protected_documents',
    dataSource: unknown = 'main',
  ) =>
    agent(tenant, role)
      .resource('charts')
      .query({
        values: {
          uid: 'authenticated-total',
          dataSource,
          collection,
          measures: [{ field: ['amount'], aggregation: 'sum', alias: 'total' }],
          dimensions: [],
          filter: {},
          orders: [],
          cache: { enabled: true, ttl: 30 },
        },
      });

  beforeAll(async () => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreFactoryEntry!).href);
    app = await createTenantApp({ aclFactory: createACL, extraPlugins: [ExportPlugin, DataVisualizationPlugin] });
    expect(typeof (app.acl as any).registerActionParamsResolver).toBe('function');
    for (const id of ['H', 'B', 'C', 'X']) {
      await app.db.getRepository('tenants').create({ values: { id, name: id, enabled: true } });
    }
    await app.db.getRepository('roles').create({
      values: {
        name: 'business-member',
        strategy: { actions: ['view', 'count', 'create', 'update', 'destroy', 'export'] },
      },
    });
    await app.db
      .getRepository('roles')
      .create({ values: { name: 'business-no-export', strategy: { actions: ['view'] } } });
    await app.db.getRepository('roles').create({ values: { name: 'business-denied', strategy: { actions: [] } } });
    user = await app.db.getRepository('users').create({
      values: {
        username: 'protected-business-user',
        roles: ['business-member', 'business-denied', 'business-no-export'],
        tenants: ['B', 'C'],
        defaultTenantId: 'B',
      },
    });
    for (const name of ['protected_documents', 'legacy_documents', 'unconfigured_documents']) {
      await app.db.getRepository('collections').create({
        values: {
          name,
          tenancy: 'tenantScoped',
          timestamps: false,
          createdBy: false,
          updatedBy: false,
          fields: [
            { name: 'name', type: 'string' },
            { name: 'amount', type: 'integer' },
          ],
        },
        context: {},
      });
      await app.db.getCollection(name).model.bulkCreate([
        { id: 1, tenantId: 'H', name: 'Visible only', amount: 100 },
        { id: 2, tenantId: 'B', name: 'Owned by B', amount: 200 },
        { id: 3, tenantId: 'C', name: 'Owned by C', amount: 300 },
      ]);
    }
    const record = await app.db.getRepository('collections').findOne({ filterByTk: 'protected_documents' });
    identity = { dataSourceKey: 'main', collectionKey: record.get('key'), collectionName: 'protected_documents' };
    const unconfigured = await app.db.getRepository('collections').findOne({ filterByTk: 'unconfigured_documents' });
    unconfiguredIdentity = {
      dataSourceKey: 'main',
      collectionKey: unconfigured.get('key'),
      collectionName: 'unconfigured_documents',
    };
    const identities = [identity, unconfiguredIdentity];
    identities.forEach((value) => selectedKeys.add(value.collectionKey));
    app.db.collection(accessConfigHistory);
    await app.db.getCollection('tenantAccessRevisions').model.sync();
    const registry = new AccessMainRootResourceRegistry(app);
    store = registry.store;
    await store.save(
      identity,
      {
        ...configFor(ownerCondition),
        revision: 0,
        rules: [
          ...configFor(ownerCondition).rules,
          {
            ...configFor(
              {
                type: 'compare',
                operator: 'eq',
                left: { type: 'field', path: 'amount' },
                right: { type: 'literal', value: 100 },
              },
              'visibility',
            ).rules[0],
            id: 'visible-only',
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
                  right: { type: 'literal', value: 'business-member' },
                },
              ],
            },
          },
        ],
      },
      { userId: user.get('id') },
    );
    const adapter = new AccessAclScopeAdapter(app.acl, 'main', store, app.db);
    unregister = adapter.register();
    registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) => registry.select(ctx, adapter, [...selectedKeys]));
  });

  afterAll(async () => {
    unregister?.();
    await app?.destroy();
  });

  it('uses authenticated tenant selection and G or V before the legacy tenant guard', async () => {
    const b = await agent()
      .resource('protected_documents')
      .list({ fields: ['id'], sort: ['id'] });
    expect(b.status).toBe(200);
    expect(b.body.data).toEqual([{ id: 1 }, { id: 2 }]);
    const c = await agent('C')
      .resource('protected_documents')
      .list({ fields: ['id'], sort: ['id'] });
    expect(c.status).toBe(200);
    expect(c.body.data).toEqual([{ id: 1 }, { id: 3 }]);
    const detail = await agent()
      .resource('protected_documents')
      .get({ filterByTk: 1, fields: ['id'] });
    expect(detail.status).toBe(200);
    expect(detail.body.data).toEqual({ id: 1 });
    const count = await agent().resource('protected_documents').count();
    expect(count.status).toBe(200);
    expect(count.body.data).toBe(2);
  });

  it('keeps unselected legacy tables on their original tenant guard', async () => {
    const response = await agent()
      .resource('legacy_documents')
      .list({ fields: ['id'], sort: ['id'] });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ id: 2 }]);
  });

  it('retains operation ACL and rejects anonymous access', async () => {
    const denied = await agent('B', 'business-denied').resource('protected_documents').list();
    expect(denied.status).toBe(403);
    const anonymous = await app.agent().resource('protected_documents').list();
    expect([401, 403]).toContain(anonymous.status);
  });

  it('keeps a selected but unconfigured table on its original tenant guard', async () => {
    const response = await agent()
      .resource('unconfigured_documents')
      .list({ fields: ['id'], sort: ['id'] });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ id: 2 }]);
  });

  it('does not turn a non-member tenant header into trusted access identity', async () => {
    // A business request cannot select a tenant outside the authenticated user's memberships.
    const response = await agent('X')
      .resource('protected_documents')
      .list({ fields: ['id'], sort: ['id'] });
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
  });

  it('writes owned records but leaves visibility-only records unchanged', async () => {
    const denied = await agent()
      .resource('protected_documents')
      .update({ filterByTk: 1, values: { name: 'Forged' } });
    expect(denied.status).toBe(403);
    const allowed = await agent()
      .resource('protected_documents')
      .update({ filterByTk: 2, values: { name: 'Edited by B' } });
    expect(allowed.status).toBe(200);
    const rows = await app.db.getCollection('protected_documents').model.findAll({ order: [['id', 'ASC']] });
    expect(rows.map((row) => [row.get('id'), row.get('name'), row.get('tenantId')])).toEqual([
      [1, 'Visible only', 'H'],
      [2, 'Edited by B', 'B'],
      [3, 'Owned by C', 'C'],
    ]);
  });

  it('creates and deletes through the authenticated runtime while preserving actual ownership', async () => {
    const created = await agent()
      .resource('protected_documents')
      .create({ values: { name: 'New B', amount: 400 } });
    expect(created.status).toBe(200);
    const record = await app.db.getRepository('protected_documents').findOne({ filter: { name: 'New B' } });
    expect(record?.get('tenantId')).toBe('B');
    const removed = await agent()
      .resource('protected_documents')
      .destroy({ filterByTk: record!.get('id') });
    expect(removed.status).toBe(200);
    expect(await app.db.getRepository('protected_documents').count({ filter: { name: 'New B' } })).toBe(0);
  });

  it('discovers a newly selected table on the next request without activating saved rules by themselves', async () => {
    const record = await app.db.getRepository('collections').findOne({ filterByTk: 'legacy_documents' });
    const legacy = { dataSourceKey: 'main', collectionKey: record.get('key'), collectionName: 'legacy_documents' };
    await store.save(
      legacy,
      { ...configFor({ type: 'constant', value: true }), revision: 0 },
      { userId: user.get('id') },
    );
    const before = await agent()
      .resource('legacy_documents')
      .list({ fields: ['id'], sort: ['id'] });
    expect(before.status).toBe(200);
    expect(before.body.data).toEqual([{ id: 2 }]);
    selectedKeys.add(legacy.collectionKey);
    try {
      const after = await agent()
        .resource('legacy_documents')
        .list({ fields: ['id'], sort: ['id'] });
      expect(after.status).toBe(200);
      expect(after.body.data).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    } finally {
      selectedKeys.delete(legacy.collectionKey);
    }
  });

  it('rejects a selected runtime table whose persistent key no longer matches metadata', async () => {
    const collection = app.db.getCollection('protected_documents');
    const key = collection.options.key;
    collection.options.key = 'different-runtime-key';
    try {
      const response = await agent()
        .resource('protected_documents')
        .list({ fields: ['id'], sort: ['id'] });
      expect(response.status).toBe(409);
      expect(response.body).not.toHaveProperty('data');
    } finally {
      collection.options.key = key;
    }
  });

  it('does not fall back when a selected registered table is absent from persistent selection', async () => {
    const model = app.db.getCollection('collections').model;
    await model.update(
      { key: 'different-persistent-key' },
      {
        where: { name: identity.collectionName },
        hooks: false,
      },
    );
    try {
      const response = await agent()
        .resource('protected_documents')
        .list({ fields: ['id'] });
      expect(response.status).toBe(409);
      expect(response.body).not.toHaveProperty('data');
    } finally {
      await model.update(
        { key: identity.collectionKey },
        {
          where: { name: identity.collectionName },
          hooks: false,
        },
      );
    }
  });

  it('uses a new configuration snapshot for the next authenticated request', async () => {
    const original = (await store.read(identity))!;
    await store.save(identity, { ...original, rules: [] }, { userId: user.get('id') });
    try {
      const response = await agent()
        .resource('protected_documents')
        .list({ fields: ['id'] });
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
      expect(response.body.meta.count).toBe(0);
    } finally {
      const latest = (await store.read(identity))!;
      await store.save(identity, { ...original, revision: latest.revision }, { userId: user.get('id') });
    }
  });

  it('exports the authenticated G or V rows as a real XLSX file', async () => {
    const b = await exportFile();
    expect(b.status).toBe(200);
    expect(b.headers['content-disposition']).toContain('Access%20report_B.xlsx');
    expect(xlsx.parse(b.body)[0].data).toEqual([['amount'], [100], [200]]);
    const c = await exportFile('C');
    expect(c.status).toBe(200);
    expect(c.headers['content-disposition']).toContain('Access%20report_C.xlsx');
    expect(xlsx.parse(c.body)[0].data).toEqual([['amount'], [100], [300]]);
  });

  it('does not borrow list permission to authorize an XLSX export', async () => {
    const response = await exportFile('B', 'business-no-export');
    expect(response.status).toBe(403);
    expect(response.headers).not.toHaveProperty('content-disposition');
  });

  it('retains the original export pipeline and tenant guard for an unselected table', async () => {
    const response = await exportFile('B', 'business-member', 'legacy_documents');
    expect(response.status).toBe(200);
    expect(xlsx.parse(response.body)[0].data).toEqual([['amount'], [200]]);
  });

  it('aggregates authenticated G or V rows without reusing another tenant chart result', async () => {
    const b = await chart();
    expect(b.status).toBe(200);
    expect(b.body).toEqual({ data: [{ total: 300 }] });
    const c = await chart('C');
    expect(c.status).toBe(200);
    expect(c.body).toEqual({ data: [{ total: 400 }] });
    const again = await chart();
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ data: [{ total: 300 }] });
  });

  it('requires collection list permission even when the chart resource allows the user', async () => {
    const response = await chart('B', 'business-denied');
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
  });

  it('retains the original chart pipeline for an unselected table', async () => {
    const response = await chart('B', 'business-member', 'legacy_documents');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [{ total: 200 }] });
  });

  it.each([null, ''])('does not bypass selected chart authorization with dataSource %j', async (dataSource) => {
    const response = await chart('B', 'business-member', 'protected_documents', dataSource);
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
  });
});

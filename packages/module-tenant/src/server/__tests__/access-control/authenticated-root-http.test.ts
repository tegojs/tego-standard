import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';
import type { Model } from '@tego/server';

import ExportPlugin from '../../../../../plugin-action-export/src/server';
import ImportPlugin from '../../../../../plugin-action-import/src/server';
import DataVisualizationPlugin from '../../../../../plugin-block-charts/src/server/plugin';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import type { AccessCollectionIdentity, AccessConfigStore } from '../../access-control/config-store';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { isolatedPostgresDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const coreFactoryEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;
const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const xlsx = createRequire(new URL('../../../../../plugin-action-export/package.json', import.meta.url))(
  'node-xlsx',
) as {
  parse(data: Buffer): Array<{ data: unknown[][] }>;
  build(data: Array<{ name: string; data: unknown[][] }>): Buffer;
};

/** Installed auth/ACL/tenant plugins, using an explicitly selected local core ACL before plugin load. */
describe.skipIf(!coreFactoryEntry)('authenticated protected root requests', () => {
  let app: MockServer;
  let user: Model;
  let token: string;
  const account = 'protected-business-user';
  const password = 'tenant-access-test-password';
  let identity: AccessCollectionIdentity;
  let unconfiguredIdentity: AccessCollectionIdentity;
  let store: AccessConfigStore;
  const selectedKeys = new Set<string>();
  let unregister: (() => void) | undefined;
  const agent = (tenant = 'B', role = 'business-member') =>
    app
      .agent()
      .set('Authorization', `Bearer ${token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', role)
      .set('X-Tenant-Id', tenant);
  const importFile = (data: unknown[][], tenant = 'B', role = 'business-member', collection = 'protected_documents') =>
    agent(tenant, role)
      .post(`/${collection}:importXlsx`)
      .attach('file', xlsx.build([{ name: 'Import', data }]), { filename: 'authenticated-import.xlsx' })
      .field(
        'columns',
        JSON.stringify([
          { dataIndex: ['name'], defaultTitle: 'Name' },
          { dataIndex: ['amount'], defaultTitle: 'Amount' },
        ]),
      );
  const exportFile = (
    tenant = 'B',
    role = 'business-member',
    collection = 'protected_documents',
    params: object = { title: 'Access report', sort: ['id'], values: { columns: ['amount'] } },
    sourceId?: string | number,
  ) =>
    agent(tenant, role)
      .resource(collection, sourceId)
      .export(params)
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
    const isolated = postgresUrl ? isolatedPostgresDatabase(postgresUrl) : undefined;
    const database = isolated?.options;
    await isolated?.close();
    app = await createTenantApp({
      aclFactory: createACL,
      database,
      extraPlugins: [ExportPlugin, ImportPlugin, DataVisualizationPlugin],
    });
    expect(typeof (app.acl as any).registerActionParamsResolver).toBe('function');
    for (const id of ['H', 'B', 'C', 'X']) {
      await app.db.getRepository('tenants').create({ values: { id, name: id, enabled: true } });
    }
    for (const action of ['add', 'remove', 'set']) app.acl.setAvailableAction(action, {});
    await app.db.getRepository('roles').create({
      values: {
        name: 'business-member',
        strategy: {
          actions: ['view', 'count', 'create', 'update', 'destroy', 'export', 'importXlsx', 'add', 'remove', 'set'],
        },
      },
    });
    await app.db
      .getRepository('roles')
      .create({ values: { name: 'business-no-export', strategy: { actions: ['view'] } } });
    await app.db.getRepository('roles').create({ values: { name: 'business-denied', strategy: { actions: [] } } });
    await app.db
      .getRepository('roles')
      .create({ values: { name: 'business-create-only', strategy: { actions: ['create'] } } });
    await app.db
      .getRepository('roles')
      .create({ values: { name: 'business-import-name-only', strategy: { actions: [] } } });
    app.acl.getRole('business-import-name-only').grantAction('protected_documents:importXlsx', { fields: ['name'] });
    await app.db.getRepository('roles').create({ values: { name: 'business-target-only', strategy: { actions: [] } } });
    app.acl.getRole('business-target-only').grantAction('protected_documents:view', {});
    await app.db.getRepository('roles').create({ values: { name: 'business-source-only', strategy: { actions: [] } } });
    app.acl.getRole('business-source-only').grantAction('protected_sources:update', {});
    await app.db
      .getRepository('roles')
      .create({ values: { name: 'business-link-no-update', strategy: { actions: [] } } });
    app.acl.getRole('business-link-no-update').grantAction('protected_documents:add', {});
    app.acl.getRole('business-link-no-update').grantAction('protected_sources:add', {});
    app.acl.getRole('business-link-no-update').grantAction('protected_sources:list', {});
    await app.db
      .getRepository('roles')
      .create({ values: { name: 'business-legacy-scope', strategy: { actions: [] } } });
    app.acl.getRole('business-legacy-scope').grantAction('legacy_sources:list', { filter: { 'document.amount': 200 } });
    user = await app.db.getRepository('users').create({
      values: {
        username: account,
        password,
        roles: [
          'business-member',
          'business-denied',
          'business-create-only',
          'business-import-name-only',
          'business-no-export',
          'business-target-only',
          'business-source-only',
          'business-link-no-update',
          'business-legacy-scope',
        ],
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
    const sources = await app.db.getRepository('collections').create({
      values: {
        name: 'protected_sources',
        tenancy: 'tenantScoped',
        timestamps: false,
        createdBy: false,
        updatedBy: false,
        fields: [{ name: 'document', type: 'belongsTo', target: 'protected_documents', foreignKey: 'documentId' }],
      },
      context: {},
    });
    const sourceIdentity = {
      dataSourceKey: 'main',
      collectionName: 'protected_sources',
      collectionKey: sources.get('key'),
    };
    selectedKeys.add(sourceIdentity.collectionKey);
    await app.db.getRepository('fields').create({
      values: {
        name: 'sources',
        type: 'hasMany',
        collectionName: 'protected_documents',
        target: 'protected_sources',
        foreignKey: 'documentId',
      },
      context: {},
    });
    await app.db.getCollection('protected_sources').model.bulkCreate([
      { id: 1, tenantId: 'B', documentId: 1 },
      { id: 2, tenantId: 'C', documentId: 2 },
      { id: 3, tenantId: 'B', documentId: 3 },
    ]);
    await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: 'legacy_sources',
        tenancy: 'tenantScoped',
        timestamps: false,
        createdBy: false,
        updatedBy: false,
        fields: [{ name: 'document', type: 'belongsTo', target: 'protected_documents', foreignKey: 'documentId' }],
      },
    });
    await app.db.getRepository('fields').create({
      values: {
        name: 'sources',
        type: 'hasMany',
        collectionName: 'legacy_documents',
        target: 'legacy_sources',
        foreignKey: 'legacyDocumentId',
      },
      context: {},
    });
    await app.db
      .getCollection('legacy_sources')
      .model.bulkCreate([{ id: 1, tenantId: 'B', documentId: 2, legacyDocumentId: 2 }]);
    app.db.collection(accessConfigHistory);
    await app.db.getCollection('tenantAccessRevisions').model.sync();
    const registry = new AccessMainRootResourceRegistry(app);
    store = registry.store;
    await store.save(sourceIdentity, { ...configFor(ownerCondition), revision: 0 }, { userId: user.get('id') });
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
    const signedIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({ account, password });
    expect(signedIn.status).toBe(200);
    expect(String(signedIn.body.data.user.id)).toBe(String(user.get('id')));
    expect(signedIn.body.data.user.hasPassword).toBe(true);
    expect(signedIn.body.data.user).not.toHaveProperty('password');
    expect(signedIn.body.data.user).not.toHaveProperty('resetToken');
    expect(signedIn.body.data.token).toEqual(expect.any(String));
    expect(signedIn.body.data.token.length).toBeGreaterThan(0);
    token = signedIn.body.data.token;
  });

  afterAll(async () => {
    unregister?.();
    await app?.destroy();
  });

  it('resolves the password-issued bearer token to the persisted business user', async () => {
    const response = await agent().get('/auth:check');
    expect(response.status).toBe(200);
    expect(String(response.body.data.id)).toBe(String(user.get('id')));
    expect(response.body.data.hasPassword).toBe(true);
    expect(response.body.data).not.toHaveProperty('password');
    expect(response.body.data).not.toHaveProperty('resetToken');
  });

  it('does not issue a business credential for an incorrect password', async () => {
    const response = await app
      .agent()
      .post('/auth:signIn')
      .set('X-Authenticator', 'basic')
      .send({ account, password: 'incorrect-password' });
    expect(response.status).toBe(401);
    expect(response.body).not.toHaveProperty('data.token');
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

  it.each(['B', 'C'])('imports a real workbook under authenticated tenant %s and the selected G', async (tenant) => {
    const name = `Authenticated import ${tenant}`;
    const documents = app.db.getCollection('protected_documents').model;
    try {
      const response = await importFile(
        [
          ['Name', 'Amount'],
          [name, 400],
        ],
        tenant,
      );
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ data: [], meta: { successCount: 1, failureCount: 0 } });
      const rows = await documents.findAll({ where: { name }, attributes: ['name', 'amount', 'tenantId'] });
      expect(rows.map((row) => row.get())).toEqual([{ name, amount: 400, tenantId: tenant }]);
    } finally {
      await documents.destroy({ where: { name }, hooks: false });
    }
  });

  it.each([
    ['business-create-only', 403],
    ['business-import-name-only', 400],
  ] as const)('rejects an authenticated import outside role %s grants', async (role, status) => {
    const documents = app.db.getCollection('protected_documents').model;
    const before = (await documents.findAll({ order: [['id', 'ASC']] })).map((row) => row.get());
    const response = await importFile(
      [
        ['Name', 'Amount'],
        ['Import denied', 400],
      ],
      'B',
      role,
    );
    expect(response.status).toBe(status);
    expect((await documents.findAll({ order: [['id', 'ASC']] })).map((row) => row.get())).toEqual(before);
  });

  it('rejects an authenticated visibility-only import without retaining business rows', async () => {
    const original = (await store.read(identity))!;
    const documents = app.db.getCollection('protected_documents').model;
    const before = (await documents.findAll({ order: [['id', 'ASC']] })).map((row) => row.get());
    try {
      await store.save(
        identity,
        { ...original, rules: original.rules.filter((rule) => rule.category === 'visibility') },
        { userId: user.get('id') },
      );
      const response = await importFile([
        ['Name', 'Amount'],
        ['Visible import denied', 100],
      ]);
      expect(response.status).toBe(403);
      expect((await documents.findAll({ order: [['id', 'ASC']] })).map((row) => row.get())).toEqual(before);
    } finally {
      const current = (await store.read(identity))!;
      await store.save(identity, { ...original, revision: current.revision }, { userId: user.get('id') });
    }
  });

  it('rolls back every authenticated import row when a later business hook fails', async () => {
    const documents = app.db.getCollection('protected_documents').model;
    const before = (await documents.findAll({ order: [['id', 'ASC']] })).map((row) => row.get());
    documents.addHook('beforeCreate', 'authenticated-import-failure', (row) => {
      if (row.get('name') === 'Later import rejected') throw new Error('Authenticated import business failure');
    });
    try {
      const response = await importFile([
        ['Name', 'Amount'],
        ['Earlier import row', 400],
        ['Later import rejected', 500],
      ]);
      expect(response.status).toBe(500);
      expect(response.body.errors[0].message).toContain('Authenticated import business failure');
      expect((await documents.findAll({ order: [['id', 'ASC']] })).map((row) => row.get())).toEqual(before);
    } finally {
      documents.removeHook('beforeCreate', 'authenticated-import-failure');
    }
  });

  it('keeps an unselected authenticated import on the original importer and tenant guard', async () => {
    const documents = app.db.getCollection('legacy_documents').model;
    const name = 'Legacy authenticated import';
    try {
      const response = await importFile(
        [
          ['Name', 'Amount'],
          [name, 400],
        ],
        'B',
        'business-member',
        'legacy_documents',
      );
      expect(response.status).toBe(200);
      expect(response.body.meta).toMatchObject({ successCount: 1, failureCount: 0 });
      const rows = await documents.findAll({ where: { name }, attributes: ['name', 'amount', 'tenantId'] });
      expect(rows.map((row) => row.get())).toEqual([{ name, amount: 400, tenantId: 'B' }]);
    } finally {
      await documents.destroy({ where: { name }, hooks: false });
    }
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

  it.each(['body', 'queryJson'] as const)(
    'rejects legacy export %s columns that expand a selected target',
    async (kind) => {
      const original = (await store.read(identity))!;
      const columns = [{ dataIndex: ['document', 'amount'], title: 'Target amount' }];
      const params = kind === 'body' ? { values: { columns } } : { columns: JSON.stringify(columns) };
      const request = () => exportFile('B', 'business-member', 'legacy_sources', params);
      try {
        await store.save(identity, { ...original, rules: [] }, { userId: user.get('id') });
        const direct = await agent()
          .resource('protected_documents')
          .list({ fields: ['id'] });
        expect(direct.status).toBe(200);
        expect(direct.body.data).toEqual([]);
        selectedKeys.delete(identity.collectionKey);
        const legacy = await request();
        expect(legacy.status).toBe(200);
        expect(xlsx.parse(legacy.body)[0].data).toEqual([['Target amount'], [200]]);
        selectedKeys.add(identity.collectionKey);
        const protectedFile = await request();
        expect(protectedFile.headers).not.toHaveProperty('content-disposition');
        expect(protectedFile.status).toBe(400);
      } finally {
        selectedKeys.add(identity.collectionKey);
        const latest = (await store.read(identity))!;
        await store.save(identity, { ...original, revision: latest.revision }, { userId: user.get('id') });
      }
    },
  );

  it.each(['body', 'queryJson'] as const)(
    'checks legacy association export %s columns against the actual target collection',
    async (kind) => {
      const original = (await store.read(identity))!;
      const columns = [{ dataIndex: ['document', 'amount'], title: 'Target amount' }];
      const params = kind === 'body' ? { values: { columns } } : { columns: JSON.stringify(columns) };
      const request = () => exportFile('B', 'business-member', 'legacy_documents.sources', params, 2);
      try {
        await store.save(identity, { ...original, rules: [] }, { userId: user.get('id') });
        const direct = await agent()
          .resource('protected_documents')
          .list({ fields: ['id'] });
        expect(direct.status).toBe(200);
        expect(direct.body.data).toEqual([]);
        selectedKeys.delete(identity.collectionKey);
        const legacy = await request();
        expect(legacy.status).toBe(200);
        expect(xlsx.parse(legacy.body)[0].data).toEqual([['Target amount'], [200]]);
        selectedKeys.add(identity.collectionKey);
        const protectedFile = await request();
        expect(protectedFile.headers).not.toHaveProperty('content-disposition');
        expect(protectedFile.status).toBe(400);
      } finally {
        selectedKeys.add(identity.collectionKey);
        const latest = (await store.read(identity))!;
        await store.save(identity, { ...original, revision: latest.revision }, { userId: user.get('id') });
      }
    },
  );

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

  it.each([
    {
      kind: 'measure',
      flat: false,
      query: { measures: [{ field: ['document', 'amount'], aggregation: 'sum', alias: 'total' }] },
      expected: [{ total: 200 }],
    },
    {
      kind: 'dimension',
      flat: false,
      query: {
        measures: [{ field: ['id'], aggregation: 'count', alias: 'total' }],
        dimensions: [{ field: ['document', 'amount'], alias: 'targetAmount' }],
      },
      expected: [{ total: 1, targetAmount: 200 }],
    },
    {
      kind: 'order',
      flat: false,
      query: {
        measures: [{ field: ['id'], alias: 'sourceId' }],
        orders: [{ field: ['document', 'amount'], order: 'desc' }],
      },
      expected: [{ sourceId: 1 }],
    },
    {
      kind: 'filter',
      flat: false,
      query: {
        measures: [{ field: ['id'], aggregation: 'count', alias: 'total' }],
        filter: { 'document.amount': 200 },
      },
      expected: [{ total: 1 }],
    },
    {
      kind: 'flat measure',
      flat: true,
      query: { measures: [{ field: ['document', 'amount'], aggregation: 'sum', alias: 'total' }] },
      expected: [{ total: 200 }],
    },
  ])(
    'rejects legacy chart $kind paths into a selected target before cached results',
    async ({ kind, flat, query, expected }) => {
      const original = (await store.read(identity))!;
      const request = () => {
        const values = {
          uid: `legacy-protected-${kind}`,
          dataSource: 'main',
          collection: 'legacy_sources',
          dimensions: [],
          orders: [],
          filter: {},
          cache: { enabled: true, ttl: 30 },
          ...query,
        };
        return agent()
          .resource('charts')
          .query(flat ? values : { values });
      };
      try {
        await store.save(identity, { ...original, rules: [] }, { userId: user.get('id') });
        const direct = await agent()
          .resource('protected_documents')
          .list({ fields: ['id'] });
        expect(direct.status).toBe(200);
        expect(direct.body.data).toEqual([]);
        selectedKeys.delete(identity.collectionKey);
        const legacy = await request();
        expect(legacy.status).toBe(200);
        expect(legacy.body.data).toEqual(expected);
        selectedKeys.add(identity.collectionKey);
        const protectedResult = await request();
        expect(protectedResult.body.data).toBeUndefined();
        expect(protectedResult.status).toBe(400);
        expect(protectedResult.body).not.toHaveProperty('data');
      } finally {
        selectedKeys.add(identity.collectionKey);
        const latest = (await store.read(identity))!;
        await store.save(identity, { ...original, revision: latest.revision }, { userId: user.get('id') });
      }
    },
  );

  it.each([null, ''])('does not bypass selected chart authorization with dataSource %j', async (dataSource) => {
    const response = await chart('B', 'business-member', 'protected_documents', dataSource);
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
  });

  it('keeps root-only legacy chart measures when an associated target is selected', async () => {
    const response = await agent()
      .resource('charts')
      .query({
        values: {
          dataSource: 'main',
          collection: 'legacy_sources',
          measures: [{ field: ['id'], aggregation: 'count', alias: 'total' }],
          dimensions: [],
          orders: [],
          filter: {},
        },
      });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ total: 1 }]);
  });

  it.each([false, true])('checks chart source role filters before cached results with flat=%s', async (flat) => {
    const original = (await store.read(identity))!;
    const sources = app.db.getCollection('legacy_sources').model;
    await sources.bulkCreate([{ id: 4, tenantId: 'B', documentId: 3 }]);
    expect((await sources.findByPk(4))?.get('tenantId')).toBe('B');
    const request = (role = 'business-legacy-scope') => {
      const values = {
        uid: `legacy-chart-role-${flat}`,
        dataSource: 'main',
        collection: 'legacy_sources',
        measures: [{ field: ['id'], aggregation: 'count', alias: 'total' }],
        dimensions: [],
        orders: [],
        filter: {},
        cache: { enabled: true, ttl: 30 },
      };
      return agent('B', role)
        .resource('charts')
        .query(flat ? values : { values });
    };
    try {
      await store.save(identity, { ...original, rules: [] }, { userId: user.get('id') });
      const direct = await agent()
        .resource('protected_documents')
        .list({ fields: ['id'] });
      expect(direct.status).toBe(200);
      expect(direct.body.data).toEqual([]);
      selectedKeys.delete(identity.collectionKey);
      const unfiltered = await request('business-member');
      expect(unfiltered.status).toBe(200);
      expect(unfiltered.body.data).toEqual([{ total: 2 }]);
      const scoped = await request();
      expect(scoped.status).toBe(200);
      expect(scoped.body.data).toEqual([{ total: 1 }]);
      selectedKeys.add(identity.collectionKey);
      const protectedResult = await request();
      expect(protectedResult.body.data).toBeUndefined();
      expect(protectedResult.status).toBe(400);
    } finally {
      selectedKeys.add(identity.collectionKey);
      await sources.destroy({ where: { id: 4 }, hooks: false });
      const latest = (await store.read(identity))!;
      await store.save(identity, { ...original, revision: latest.revision }, { userId: user.get('id') });
    }
  });

  it('reads a concrete association using separate source and target G or V scopes', async () => {
    const visible = await agent()
      .resource('protected_sources.document', 1)
      .get({ fields: ['id'] });
    expect(visible.status).toBe(200);
    expect(visible.body.data).toEqual({ id: 1 });
    const hiddenSource = await agent()
      .resource('protected_sources.document', 2)
      .get({ fields: ['id'] });
    expect(hiddenSource.status).toBe(403);
    expect(hiddenSource.body).not.toHaveProperty('data');
    const hiddenTarget = await agent()
      .resource('protected_sources.document', 3)
      .get({ fields: ['id'] });
    expect(hiddenTarget.status).toBe(200);
    expect(hiddenTarget.body.data).toBeNull();
  });

  it('requires source list permission for a concrete association independently of the target grant', async () => {
    const response = await agent('B', 'business-target-only')
      .resource('protected_sources.document', 1)
      .get({ fields: ['id'] });
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
  });

  it('reads placeholder association targets without a concrete source or source list permission', async () => {
    const response = await agent('B', 'business-target-only')
      .resource('protected_sources.document', '_')
      .list({ fields: ['id'], sort: ['id'] });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ id: 2 }]);
  });

  it('keeps unsupported concrete association updates closed', async () => {
    const response = await agent()
      .resource('protected_sources.document', 1)
      .update({ values: { amount: 999 } });
    expect(response.status).toBe(400);
    expect((await app.db.getCollection('protected_documents').model.findByPk(1))?.get('amount')).toBe(100);
  });

  it.each(['appends', 'fields', 'filter', 'nestedFilter', 'sort', 'count', 'roleFilter'] as const)(
    'rejects unsupported legacy-to-protected %s paths instead of using the old target rules',
    async (kind) => {
      const original = (await store.read(identity))!;
      try {
        await store.save(identity, { ...original, rules: [] }, { userId: user.get('id') });
        const direct = await agent()
          .resource('protected_documents')
          .list({ fields: ['id'] });
        expect(direct.status).toBe(200);
        expect(direct.body.data).toEqual([]);
        const scalar = await agent()
          .resource('legacy_sources')
          .list({ fields: ['id'] });
        expect(scalar.status).toBe(200);
        expect(scalar.body.data).toEqual([{ id: 1 }]);
        const queries = {
          appends: { fields: ['id'], appends: ['document'] },
          fields: { fields: ['id', 'document.amount'] },
          filter: { fields: ['id'], filter: { 'document.amount': 200 } },
          nestedFilter: { fields: ['id'], filter: { $and: [{ document: { amount: { $eq: 200 } } }] } },
          sort: { fields: ['id'], sort: ['document.amount'] },
          roleFilter: { fields: ['id'] },
        };
        const resource = agent('B', kind === 'roleFilter' ? 'business-legacy-scope' : 'business-member').resource(
          'legacy_sources',
        );
        const response =
          kind === 'count'
            ? await resource.count({ filter: { 'document.amount': 200 } })
            : await resource.list(queries[kind]);
        expect({ status: response.status, data: response.body.data }).toEqual({ status: 400, data: undefined });
      } finally {
        const current = (await store.read(identity))!;
        await store.save(identity, { ...original, revision: current.revision }, { userId: user.get('id') });
      }
    },
  );

  it('keeps a saved but unselected association target on the legacy path', async () => {
    selectedKeys.delete(identity.collectionKey);
    try {
      const response = await agent()
        .resource('legacy_sources')
        .list({ fields: ['id'], appends: ['document'] });
      expect(response.status).toBe(200);
      expect(response.body.data[0].document.id).toBe(2);
    } finally {
      selectedKeys.add(identity.collectionKey);
    }
  });

  it('keeps unrelated legacy scalar updates on their original handler', async () => {
    try {
      const response = await agent()
        .resource('legacy_documents')
        .update({ filterByTk: 2, values: { amount: 250 } });
      expect(response.status).toBe(200);
      expect((await app.db.getCollection('legacy_documents').model.findByPk(2))?.get('amount')).toBe(250);
    } finally {
      await app.db.getCollection('legacy_documents').model.update({ amount: 200 }, { where: { id: 2 }, hooks: false });
    }
  });

  it('keeps legacy reference updates when the configured target has not been selected', async () => {
    const sources = app.db.getCollection('legacy_sources').model;
    selectedKeys.delete(identity.collectionKey);
    await sources.update({ documentId: null }, { where: { id: 1 }, hooks: false });
    try {
      const response = await agent()
        .resource('legacy_sources')
        .update({ filterByTk: 1, values: { document: 2 } });
      expect(response.status).toBe(200);
      expect((await sources.findByPk(1))?.get('documentId')).toBe(2);
    } finally {
      selectedKeys.add(identity.collectionKey);
      await sources.update({ documentId: 2 }, { where: { id: 1 }, hooks: false });
    }
  });

  it.each(
    (['create', 'update'] as const).flatMap((action) =>
      ['foreignKey', 'reference'].map((shape) => ({ action, shape })),
    ),
  )(
    'rejects legacy root $action references through $shape to a selected target hidden by its current rules',
    async ({ action, shape }) => {
      const original = (await store.read(identity))!;
      const sources = app.db.getCollection('legacy_sources').model;
      const snapshot = async () =>
        (await sources.findAll({ order: [['id', 'ASC']] })).map((row) => ({
          id: row.get('id'),
          tenantId: row.get('tenantId'),
          documentId: row.get('documentId'),
        }));
      await sources.update({ documentId: null }, { where: { id: 1 }, hooks: false });
      const before = await snapshot();
      try {
        await store.save(identity, { ...original, rules: [] }, { userId: user.get('id') });
        const direct = await agent()
          .resource('protected_documents')
          .list({ fields: ['id'] });
        expect(direct.status).toBe(200);
        expect(direct.body.data).toEqual([]);
        const response = await agent()
          .resource('legacy_sources')
          [action]({
            ...(action === 'update' ? { filterByTk: 1 } : {}),
            values: shape === 'foreignKey' ? { documentId: 2 } : { document: 2 },
          });
        expect({ status: response.status, sources: await snapshot() }).toEqual({ status: 400, sources: before });
        expect((await app.db.getCollection('protected_documents').model.findByPk(2))?.get('tenantId')).toBe('B');
      } finally {
        const added = (await snapshot()).filter((row) => !before.some((old) => old.id === row.id));
        if (added.length) await sources.destroy({ where: { id: added.map((row) => row.id) }, hooks: false });
        await sources.update({ documentId: 2 }, { where: { id: 1 }, hooks: false });
        const current = (await store.read(identity))!;
        await store.save(identity, { ...original, revision: current.revision }, { userId: user.get('id') });
      }
    },
  );

  it('exports placeholder association targets with their own export grant and G or V scope', async () => {
    const request = (tenant: string, role = 'business-member') =>
      agent(tenant, role)
        .resource('protected_sources.document', '_')
        .export({ title: 'Target report', sort: ['id'], values: { columns: ['amount'] } })
        .buffer(true)
        .parse((response, done) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          response.on('end', () => done(null, Buffer.concat(chunks)));
          response.on('error', done);
        });
    const b = await request('B');
    expect(b.status).toBe(200);
    expect(xlsx.parse(b.body)[0].data).toEqual([['amount'], [100], [200]]);
    const c = await request('C');
    expect(c.status).toBe(200);
    expect(xlsx.parse(c.body)[0].data).toEqual([['amount'], [100], [300]]);
    const denied = await request('B', 'business-no-export');
    expect(denied.status).toBe(403);
    expect(denied.headers).not.toHaveProperty('content-disposition');
  });

  it.skipIf(!postgresUrl)(
    'updates an owned root reference to G and V targets without modifying those targets',
    async () => {
      const sources = app.db.getCollection('protected_sources').model;
      const documents = app.db.getCollection('protected_documents').model;
      const before = await documents.findAll({ order: [['id', 'ASC']], raw: true });
      try {
        const owned = await agent()
          .resource('protected_sources')
          .update({ filterByTk: 1, values: { document: 2 } });
        expect(owned.status).toBe(200);
        expect((await sources.findByPk(1))?.get('documentId')).toBe(2);
        const visible = await agent()
          .resource('protected_sources')
          .update({ filterByTk: 1, values: { document: 1 } });
        expect(visible.status).toBe(200);
        expect((await sources.findByPk(1))?.get('documentId')).toBe(1);
        expect(await documents.findAll({ order: [['id', 'ASC']], raw: true })).toEqual(before);
      } finally {
        await sources.update({ documentId: 1 }, { where: { id: 1 }, hooks: false });
      }
    },
  );

  it.skipIf(!postgresUrl)('rejects a root reference to a hidden target without changing the source', async () => {
    const response = await agent()
      .resource('protected_sources')
      .update({ filterByTk: 1, values: { document: 3 } });
    expect(response.status).toBe(403);
    expect((await app.db.getCollection('protected_sources').model.findByPk(1))?.get('documentId')).toBe(1);
  });

  it.skipIf(!postgresUrl)('requires a separate target read grant when changing a root reference', async () => {
    const response = await agent('B', 'business-source-only')
      .resource('protected_sources')
      .update({ filterByTk: 1, values: { document: 2 } });
    expect(response.status).toBe(403);
    expect((await app.db.getCollection('protected_sources').model.findByPk(1))?.get('documentId')).toBe(1);
  });

  it.skipIf(!postgresUrl)('requires G on the source when changing a root reference to a visible target', async () => {
    const response = await agent()
      .resource('protected_sources')
      .update({ filterByTk: 2, values: { document: 1 } });
    expect(response.status).toBe(403);
    expect((await app.db.getCollection('protected_sources').model.findByPk(2))?.get('documentId')).toBe(2);
  });

  it.skipIf(!postgresUrl)(
    'writes concrete association links through add, set and remove without changing ownership',
    async () => {
      const documents = app.db.getCollection('protected_documents').model;
      const sources = app.db.getCollection('protected_sources').model;
      await documents.bulkCreate([{ id: 4, tenantId: 'B', name: 'Link parent', amount: 400 }]);
      try {
        expect((await documents.findByPk(4))?.get('tenantId')).toBe('B');
        const added = await agent()
          .resource('protected_documents.sources', 4)
          .add({ values: [3] });
        expect(added.status).toBe(200);
        expect((await sources.findByPk(3))?.get('documentId')).toBe(4);
        const replaced = await agent()
          .resource('protected_documents.sources', 4)
          .set({ values: [1] });
        expect(replaced.status).toBe(200);
        expect((await sources.findByPk(3))?.get('documentId')).toBeNull();
        expect((await sources.findByPk(1))?.get('documentId')).toBe(4);
        const removed = await agent()
          .resource('protected_documents.sources', 4)
          .remove({ values: [1] });
        expect(removed.status).toBe(200);
        expect((await sources.findByPk(1))?.get('documentId')).toBeNull();
        for (const id of [1, 3]) expect((await sources.findByPk(id))?.get('tenantId')).toBe('B');
        expect((await documents.findByPk(4))?.get('amount')).toBe(400);
        expect((await documents.findByPk(4))?.get('tenantId')).toBe('B');
      } finally {
        await sources.update({ documentId: 1 }, { where: { id: 1 }, hooks: false });
        await sources.update({ documentId: 3 }, { where: { id: 3 }, hooks: false });
        await documents.destroy({ where: { id: 4 }, hooks: false });
      }
    },
  );

  it.skipIf(!postgresUrl)('rejects concrete association links when set would detach a target outside G', async () => {
    const response = await agent()
      .resource('protected_documents.sources', 2)
      .set({ values: [3] });
    expect(response.status).toBe(403);
    const sources = app.db.getCollection('protected_sources').model;
    expect((await sources.findByPk(2))?.get('documentId')).toBe(2);
    expect((await sources.findByPk(3))?.get('documentId')).toBe(3);
  });

  it.skipIf(!postgresUrl)(
    'requires source G for concrete association links even when the source is visible',
    async () => {
      const response = await agent()
        .resource('protected_documents.sources', 1)
        .add({ values: [3] });
      expect(response.status).toBe(403);
      expect((await app.db.getCollection('protected_sources').model.findByPk(3))?.get('documentId')).toBe(3);
    },
  );

  it.skipIf(!postgresUrl)('requires an independent target update grant for concrete association links', async () => {
    const response = await agent('B', 'business-link-no-update')
      .resource('protected_documents.sources', 2)
      .add({ values: [3] });
    expect(response.status).toBe(403);
    expect((await app.db.getCollection('protected_sources').model.findByPk(3))?.get('documentId')).toBe(3);
  });
});

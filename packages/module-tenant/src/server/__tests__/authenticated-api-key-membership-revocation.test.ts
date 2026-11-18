import type { MockServer } from '@tachybase/test';

import xlsx from 'node-xlsx';
import ExportPlugin from 'packages/plugin-action-export/src/server';
import ImportPlugin from 'packages/plugin-action-import/src/server';
import PluginAPIKeysServer from 'packages/plugin-api-keys/src/server';

import { createTenantApp } from './utils';

describe('authenticated API key tenant membership revocation', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it('rechecks the key owner membership before accessing tenant business data', async () => {
    app = await createTenantApp({
      extraPlugins: [
        [PluginAPIKeysServer, { name: 'api-keys', packageName: '@tachybase/plugin-api-keys' }],
        [ExportPlugin, { name: 'action-export' }],
        [ImportPlugin, { name: 'action-import' }],
      ],
    });
    await app.db.getRepository('tenants').create({
      values: [
        { id: 'B', name: 'B', enabled: true },
        { id: 'C', name: 'C', enabled: true },
      ],
    });

    const issuerRole = 'membership-key-issuer';
    const writerRole = 'membership-key-writer';
    const managerRole = 'membership-key-tenant-manager';
    const password = 'membership-key-password';
    await app.db.getRepository('roles').create({
      values: [
        { name: issuerRole, strategy: { actions: [] }, snippets: ['pm.api-keys.configuration'] },
        { name: writerRole, strategy: { actions: [] }, snippets: [] },
        { name: managerRole, strategy: { actions: [] }, snippets: ['pm.tenant.manage'] },
      ],
    });
    const owner = await app.db.getRepository('users').create({
      values: {
        username: 'membership-key-owner',
        password,
        roles: [issuerRole, writerRole],
        tenants: ['B', 'C'],
        defaultTenantId: 'B',
      },
    });
    const manager = await app.db.getRepository('users').create({
      values: { username: 'membership-key-manager', password, roles: [managerRole] },
    });

    const collectionName = 'membershipKeyBusinessRecords';
    await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: collectionName,
        tenancy: 'tenantScoped',
        timestamps: false,
        createdBy: false,
        updatedBy: false,
        fields: [{ name: 'name', type: 'string' }],
      },
    });
    await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: writerRole,
        name: collectionName,
        usingActionsConfig: true,
        actions: [
          { name: 'create', fields: ['name'] },
          { name: 'export', fields: ['name'] },
          { name: 'get', fields: ['id', 'name', 'tenantId'] },
          { name: 'importXlsx', fields: ['name'] },
          { name: 'list', fields: ['name', 'tenantId'] },
          { name: 'update', fields: ['name'] },
        ],
      },
    });

    const signIn = async (username: string) => {
      const response = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
        account: username,
        password,
      });
      expect(response.status).toBe(200);
      return response.body.data.token as string;
    };
    const ownerSession = await signIn(owner.username);
    const managerToken = await signIn(manager.username);
    const issue = await app
      .agent()
      .set('Authorization', `Bearer ${ownerSession}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', issuerRole)
      .set('X-Tenant-Id', 'B')
      .resource('apiKeys')
      .create({ values: { name: 'Tenant membership key', role: { name: writerRole }, expiresIn: '1d' } });
    expect(issue.status).toBe(200);
    const apiKey = issue.body.data.token as string;
    expect(apiKey).toMatch(/^[a-f0-9]{64}$/);
    const keyRecord = await app.db.getRepository('apiKeys').findOne({ filter: { accessToken: apiKey } });
    expect(keyRecord.get('createdById')).toBe(owner.id);
    expect(keyRecord.get('roleName')).toBe(writerRole);

    const apiAgent = (tenantId: string) =>
      app
        .agent()
        .set('Authorization', `Bearer ${apiKey}`)
        .set('X-Authenticator', 'basic')
        .set('X-Role', writerRole)
        .set('X-Tenant-Id', tenantId);
    const rows = () => app.db.getCollection(collectionName).model.findAll({ raw: true, order: [['id', 'ASC']] });
    const exportInTenant = (tenantId: string) =>
      apiAgent(tenantId)
        .resource(collectionName)
        .export({
          values: {
            title: 'Membership report',
            columns: [{ dataIndex: ['name'], defaultTitle: 'Name', title: 'Name' }],
          },
        })
        .buffer(true)
        .parse((response, done) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          response.on('end', () => done(null, Buffer.concat(chunks)));
          response.on('error', done);
        });
    const importToC = () =>
      apiAgent('C')
        .post(`/${collectionName}:importXlsx`)
        .attach('file', xlsx.build([{ name: 'Records', data: [['Name'], ['C imported while member']] }]), {
          filename: 'membership-import.xlsx',
        })
        .field('columns', JSON.stringify([{ dataIndex: ['name'], defaultTitle: 'Name' }]));
    const originalRows = [
      { id: 1, name: 'B business record', tenantId: 'B' },
      { id: 2, name: 'C business record', tenantId: 'C' },
    ];
    for (const [tenantId, name] of [
      ['B', 'B business record'],
      ['C', 'C business record'],
    ]) {
      const created = await apiAgent(tenantId).resource(collectionName).create({ values: { name } });
      expect(created.status).toBe(200);
    }
    expect(await rows()).toEqual(originalRows);

    const updatedInC = await apiAgent('C')
      .resource(collectionName)
      .update({ filterByTk: 2, values: { name: 'C updated while member' } });
    expect(updatedInC.status).toBe(200);
    expect(updatedInC.body.data).toEqual([{ id: 2, name: 'C updated while member', tenantId: 'C' }]);
    const rowsAfterAuthorizedUpdate = [originalRows[0], { id: 2, name: 'C updated while member', tenantId: 'C' }];
    expect(await rows()).toEqual(rowsAfterAuthorizedUpdate);

    const inC = await apiAgent('C')
      .resource(collectionName)
      .list({ fields: ['id', 'name', 'tenantId'] });
    expect(inC.status).toBe(200);
    expect(inC.body.data).toEqual([rowsAfterAuthorizedUpdate[1]]);
    const exportInC = await exportInTenant('C');
    expect(exportInC.status).toBe(200);
    expect(exportInC.headers['content-disposition']).toContain('Membership%20report_C.xlsx');
    expect(xlsx.parse(exportInC.body)[0].data).toEqual([['Name'], ['C updated while member']]);
    const importInC = await importToC();
    expect(importInC.status).toBe(200);
    expect(importInC.body.meta).toMatchObject({ successCount: 1, failureCount: 0 });
    const rowsAfterImport = [...rowsAfterAuthorizedUpdate, { id: 3, name: 'C imported while member', tenantId: 'C' }];
    expect(await rows()).toEqual(rowsAfterImport);
    const getCWhileMember = await apiAgent('C')
      .resource(collectionName)
      .get({ filterByTk: 2, fields: ['id', 'name', 'tenantId'] });
    expect(getCWhileMember.status).toBe(200);
    expect(getCWhileMember.body.data).toEqual({ id: 2, name: 'C updated while member', tenantId: 'C' });
    const membershipsBeforeRemoval = await app.db
      .getRepository('tenantUsers')
      .find({ fields: ['tenantId', 'userId'], sort: ['tenantId', 'userId'], raw: true });
    expect(membershipsBeforeRemoval).toEqual([
      { tenantId: 'B', userId: owner.id },
      { tenantId: 'C', userId: owner.id },
    ]);

    const managerAgent = app
      .agent()
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', managerRole);
    const removed = await managerAgent.resource('tenantUsers').destroy({
      filter: { tenantId: 'C', userId: owner.id },
    });
    expect(removed.status).toBe(200);
    expect(
      await app.db
        .getRepository('tenantUsers')
        .find({ fields: ['tenantId', 'userId'], sort: ['tenantId', 'userId'], raw: true }),
    ).toEqual([{ tenantId: 'B', userId: owner.id }]);

    const denied = await apiAgent('C')
      .resource(collectionName)
      .list({ fields: ['id', 'name', 'tenantId'] });
    expect(denied.status).toBe(403);
    expect(denied.body).not.toHaveProperty('data');
    const deniedCreate = await apiAgent('C')
      .resource(collectionName)
      .create({ values: { name: 'Unauthorized C business record' } });
    expect(deniedCreate.status).toBe(403);
    expect(deniedCreate.body).not.toHaveProperty('data');
    const deniedUpdate = await apiAgent('C')
      .resource(collectionName)
      .update({ filterByTk: 2, values: { name: 'Unauthorized C update' } });
    expect(deniedUpdate.status).toBe(403);
    expect(deniedUpdate.body).not.toHaveProperty('data');
    const deniedGet = await apiAgent('C')
      .resource(collectionName)
      .get({ filterByTk: 2, fields: ['id', 'name', 'tenantId'] });
    expect(deniedGet.status).toBe(403);
    expect(deniedGet.body).not.toHaveProperty('data');
    const deniedExport = await exportInTenant('C');
    expect(deniedExport.status).toBe(403);
    expect(deniedExport.headers).not.toHaveProperty('content-disposition');
    const deniedImport = await importToC();
    expect(deniedImport.status).toBe(403);
    expect(deniedImport.body).not.toHaveProperty('data');
    expect(await rows()).toEqual(rowsAfterImport);
    const stillAuthorized = await apiAgent('B')
      .resource(collectionName)
      .list({ fields: ['id', 'name', 'tenantId'] });
    expect(stillAuthorized.status).toBe(200);
    expect(stillAuthorized.body.data).toEqual([originalRows[0]]);
    const stillAuthorizedGet = await apiAgent('B')
      .resource(collectionName)
      .get({ filterByTk: 1, fields: ['id', 'name', 'tenantId'] });
    expect(stillAuthorizedGet.status).toBe(200);
    expect(stillAuthorizedGet.body.data).toEqual({ id: 1, name: 'B business record', tenantId: 'B' });
    expect(await rows()).toEqual(rowsAfterImport);
    expect(await app.db.getRepository('apiKeys').findOne({ filter: { accessToken: apiKey } })).toBeTruthy();
    expect(await app.db.getRepository('tokenBlacklist').count()).toBe(0);
  });
});

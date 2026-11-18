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
    const childCollectionName = 'membershipKeyBusinessChildren';
    await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: childCollectionName,
        tenancy: 'tenantScoped',
        timestamps: false,
        createdBy: false,
        updatedBy: false,
        fields: [{ name: 'name', type: 'string' }],
      },
    });
    (app.pm.get('acl') as any).registerAssociationFieldAction('belongsToMany', {
      create: { associationActions: ['add', 'set', 'remove'] },
      view: { associationActions: ['list', 'get'] },
    });
    await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: collectionName,
        tenancy: 'tenantScoped',
        timestamps: false,
        createdBy: false,
        updatedBy: false,
        fields: [
          { name: 'name', type: 'string' },
          { name: 'children', type: 'belongsToMany', target: childCollectionName },
        ],
      },
    });
    await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: writerRole,
        name: collectionName,
        usingActionsConfig: true,
        actions: [
          { name: 'create', fields: ['name', 'children'] },
          { name: 'destroy' },
          { name: 'export', fields: ['name'] },
          { name: 'get', fields: ['id', 'name', 'tenantId', 'children'] },
          { name: 'importXlsx', fields: ['name'] },
          { name: 'list', fields: ['name', 'tenantId', 'children'] },
          { name: 'count' },
          { name: 'update', fields: ['name', 'children'] },
          { name: 'set', fields: ['children'] },
        ],
      },
    });
    await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: writerRole,
        name: childCollectionName,
        usingActionsConfig: true,
        actions: [
          { name: 'create', fields: ['name'] },
          { name: 'view', fields: ['id', 'name', 'tenantId'] },
          { name: 'set', fields: ['id'] },
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
    const childRows = () =>
      app.db.getCollection(childCollectionName).model.findAll({ raw: true, order: [['id', 'ASC']] });
    const children = async () =>
      (await app.db.getRepository(`${collectionName}.children`, 2).find({ sort: ['id'] })).map((record) =>
        record.get('id'),
      );
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
    const childCreated = await apiAgent('C')
      .resource(childCollectionName)
      .create({ values: { name: 'C child' } });
    expect(childCreated.status).toBe(200);
    expect(await childRows()).toEqual([{ id: 1, name: 'C child', tenantId: 'C' }]);
    const associatedWhileMember = await apiAgent('C')
      .resource(`${collectionName}.children`, 2)
      .set({ values: [1] });
    expect(associatedWhileMember.status, JSON.stringify(associatedWhileMember.body)).toBe(200);
    expect(await children()).toEqual([1]);
    const associationReadWhileMember = await apiAgent('C')
      .resource(`${collectionName}.children`, 2)
      .list({ fields: ['id', 'name', 'tenantId'] });
    expect(associationReadWhileMember.status).toBe(200);
    expect(associationReadWhileMember.body.data).toHaveLength(1);
    expect(associationReadWhileMember.body.data[0]).toMatchObject({ id: 1, name: 'C child', tenantId: 'C' });

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
    const countCWhileMember = await apiAgent('C').resource(collectionName).count({});
    expect(countCWhileMember.status).toBe(200);
    expect(countCWhileMember.body.data).toBe(2);
    const getCWhileMember = await apiAgent('C')
      .resource(collectionName)
      .get({ filterByTk: 2, fields: ['id', 'name', 'tenantId'] });
    expect(getCWhileMember.status).toBe(200);
    expect(getCWhileMember.body.data).toEqual({ id: 2, name: 'C updated while member', tenantId: 'C' });
    const deleteCWhileMember = await apiAgent('C').resource(collectionName).destroy({ filterByTk: 3 });
    expect(deleteCWhileMember.status).toBe(200);
    expect(deleteCWhileMember.body.data).toBe(1);
    const rowsAfterAuthorizedDelete = [originalRows[0], rowsAfterAuthorizedUpdate[1]];
    expect(await rows()).toEqual(rowsAfterAuthorizedDelete);
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
    const deniedCount = await apiAgent('C').resource(collectionName).count({});
    expect(deniedCount.status).toBe(403);
    expect(deniedCount.body).not.toHaveProperty('data');
    const deniedDelete = await apiAgent('C').resource(collectionName).destroy({ filterByTk: 2 });
    expect(deniedDelete.status).toBe(403);
    expect(deniedDelete.body).not.toHaveProperty('data');
    const deniedExport = await exportInTenant('C');
    expect(deniedExport.status).toBe(403);
    expect(deniedExport.headers).not.toHaveProperty('content-disposition');
    const deniedImport = await importToC();
    expect(deniedImport.status).toBe(403);
    expect(deniedImport.body).not.toHaveProperty('data');
    expect(await rows()).toEqual(rowsAfterAuthorizedDelete);
    const deniedAssociationSet = await apiAgent('C').resource(`${collectionName}.children`, 2).set({ values: [] });
    expect(deniedAssociationSet.status).toBe(403);
    expect(deniedAssociationSet.body).not.toHaveProperty('data');
    expect(await children()).toEqual([1]);
    const deniedAssociationList = await apiAgent('C')
      .resource(`${collectionName}.children`, 2)
      .list({ fields: ['id', 'name', 'tenantId'] });
    expect(deniedAssociationList.status).toBe(403);
    expect(deniedAssociationList.body).not.toHaveProperty('data');
    expect(await children()).toEqual([1]);
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
    const stillAuthorizedCount = await apiAgent('B').resource(collectionName).count({});
    expect(stillAuthorizedCount.status).toBe(200);
    expect(stillAuthorizedCount.body.data).toBe(1);
    expect(await rows()).toEqual(rowsAfterAuthorizedDelete);
    expect(await app.db.getRepository('apiKeys').findOne({ filter: { accessToken: apiKey } })).toBeTruthy();
    expect(await app.db.getRepository('tokenBlacklist').count()).toBe(0);
  });
});

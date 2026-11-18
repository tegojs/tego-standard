import type { MockServer } from '@tachybase/test';

import xlsx from 'node-xlsx';
import ExportPlugin from 'packages/plugin-action-export/src/server';
import PluginAPIKeysServer from 'packages/plugin-api-keys/src/server';

import { createTenantApp } from './utils';

describe('authenticated API key role revocation', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it('rechecks the key owner role membership before tenant business access', async () => {
    app = await createTenantApp({
      extraPlugins: [
        [PluginAPIKeysServer, { name: 'api-keys', packageName: '@tachybase/plugin-api-keys' }],
        [ExportPlugin, { name: 'action-export' }],
      ],
    });
    await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });

    const issuerRole = 'role-key-issuer';
    const writerRole = 'role-key-writer';
    const password = 'role-key-password';
    await app.db.getRepository('roles').create({
      values: [
        { name: issuerRole, strategy: { actions: [] }, snippets: ['pm.api-keys.configuration'] },
        { name: writerRole, strategy: { actions: [] }, snippets: [] },
      ],
    });
    const owner = await app.db.getRepository('users').create({
      values: {
        username: 'role-key-owner',
        password,
        roles: [issuerRole, writerRole],
        tenants: ['B'],
        defaultTenantId: 'B',
      },
    });

    const collectionName = 'roleRevocationBusinessRecords';
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
          { name: 'count' },
          { name: 'export', fields: ['name'] },
          { name: 'get', fields: ['id', 'name', 'tenantId'] },
          { name: 'list', fields: ['name', 'tenantId'] },
          { name: 'update', fields: ['name'] },
        ],
      },
    });

    const signedIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
      account: owner.username,
      password,
    });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.data.user).toMatchObject({ id: owner.id, hasPassword: true });
    const issued = await app
      .agent()
      .set('Authorization', `Bearer ${signedIn.body.data.token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', issuerRole)
      .set('X-Tenant-Id', 'B')
      .resource('apiKeys')
      .create({ values: { name: 'Role revocation key', role: { name: writerRole }, expiresIn: '1d' } });
    expect(issued.status).toBe(200);
    const apiKey = issued.body.data.token as string;
    expect(apiKey).toMatch(/^[a-f0-9]{64}$/);
    const keyRecord = await app.db.getRepository('apiKeys').findOne({ filter: { accessToken: apiKey } });
    expect(keyRecord.get('createdById')).toBe(owner.id);
    expect(keyRecord.get('roleName')).toBe(writerRole);

    const apiAgent = () =>
      app
        .agent()
        .set('Authorization', `Bearer ${apiKey}`)
        .set('X-Authenticator', 'basic')
        .set('X-Role', writerRole)
        .set('X-Tenant-Id', 'B');
    const rows = () => app.db.getCollection(collectionName).model.findAll({ raw: true, order: [['id', 'ASC']] });
    const exportBusinessRows = () =>
      apiAgent()
        .resource(collectionName)
        .export({
          values: {
            title: 'Role revocation report',
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
    const created = await apiAgent()
      .resource(collectionName)
      .create({ values: { name: 'Before role removal' } });
    expect(created.status).toBe(200);
    const updatedBeforeRemoval = await apiAgent()
      .resource(collectionName)
      .update({ filterByTk: 1, values: { name: 'Updated before role removal' } });
    expect(updatedBeforeRemoval.status).toBe(200);
    expect(updatedBeforeRemoval.body.data).toEqual([{ id: 1, name: 'Updated before role removal', tenantId: 'B' }]);
    const originalRows = [{ id: 1, name: 'Updated before role removal', tenantId: 'B' }];
    expect(await rows()).toEqual(originalRows);
    const countBeforeRemoval = await apiAgent().resource(collectionName).count({});
    expect(countBeforeRemoval.status).toBe(200);
    expect(countBeforeRemoval.body.data).toBe(1);
    const listed = await apiAgent()
      .resource(collectionName)
      .list({ fields: ['name', 'tenantId'] });
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0]).toMatchObject({ name: 'Updated before role removal', tenantId: 'B' });
    const fetched = await apiAgent()
      .resource(collectionName)
      .get({ filterByTk: 1, fields: ['id', 'name', 'tenantId'] });
    expect(fetched.status).toBe(200);
    expect(fetched.body.data).toEqual({ id: 1, name: 'Updated before role removal', tenantId: 'B' });
    const exportBeforeRemoval = await exportBusinessRows();
    expect(exportBeforeRemoval.status).toBe(200);
    expect(exportBeforeRemoval.headers['content-disposition']).toContain('Role%20revocation%20report_B.xlsx');
    expect(xlsx.parse(exportBeforeRemoval.body)[0].data).toEqual([['Name'], ['Updated before role removal']]);

    await app.db.getRepository('rolesUsers').destroy({ filter: { userId: owner.id, roleName: writerRole } });
    expect(
      await app.db.getCollection('rolesUsers').model.findAll({
        where: { userId: owner.id },
        attributes: ['roleName'],
        raw: true,
      }),
    ).toEqual([{ roleName: issuerRole }]);

    const revokedList = await apiAgent()
      .resource(collectionName)
      .list({ fields: ['name', 'tenantId'] });
    expect(revokedList.status).toBe(401);
    expect(revokedList.body.errors[0].code).toBe('ROLE_NOT_FOUND_ERR');
    const revokedGet = await apiAgent()
      .resource(collectionName)
      .get({ filterByTk: 1, fields: ['id', 'name', 'tenantId'] });
    expect(revokedGet.status).toBe(401);
    expect(revokedGet.body.errors[0].code).toBe('ROLE_NOT_FOUND_ERR');
    expect(revokedGet.body).not.toHaveProperty('data');
    const revokedCount = await apiAgent().resource(collectionName).count({});
    expect(revokedCount.status).toBe(401);
    expect(revokedCount.body.errors[0].code).toBe('ROLE_NOT_FOUND_ERR');
    expect(revokedCount.body).not.toHaveProperty('data');
    const revokedExport = await exportBusinessRows();
    expect(revokedExport.status).toBe(401);
    expect(revokedExport.headers).not.toHaveProperty('content-disposition');
    const revokedUpdate = await apiAgent()
      .resource(collectionName)
      .update({ filterByTk: 1, values: { name: 'Unauthorized after role removal' } });
    expect(revokedUpdate.status).toBe(401);
    expect(revokedUpdate.body.errors[0].code).toBe('ROLE_NOT_FOUND_ERR');
    expect(revokedUpdate.body).not.toHaveProperty('data');
    const revokedCreate = await apiAgent()
      .resource(collectionName)
      .create({ values: { name: 'After role removal' } });
    expect(revokedCreate.status).toBe(401);
    expect(revokedCreate.body.errors[0].code).toBe('ROLE_NOT_FOUND_ERR');
    expect(await rows()).toEqual(originalRows);
    expect(await app.db.getRepository('apiKeys').findOne({ filter: { accessToken: apiKey } })).toBeTruthy();
    expect(await app.db.getRepository('tokenBlacklist').count()).toBe(0);

    await app.db.getRepository('rolesUsers').create({ values: { userId: owner.id, roleName: writerRole } });
    const restoredList = await apiAgent()
      .resource(collectionName)
      .list({ fields: ['name', 'tenantId'] });
    expect(restoredList.status).toBe(200);
    expect(restoredList.body.data).toHaveLength(1);
    expect(restoredList.body.data[0]).toMatchObject({ name: 'Updated before role removal', tenantId: 'B' });
    const restoredGet = await apiAgent()
      .resource(collectionName)
      .get({ filterByTk: 1, fields: ['id', 'name', 'tenantId'] });
    expect(restoredGet.status).toBe(200);
    expect(restoredGet.body.data).toEqual({ id: 1, name: 'Updated before role removal', tenantId: 'B' });
    const restoredCount = await apiAgent().resource(collectionName).count({});
    expect(restoredCount.status).toBe(200);
    expect(restoredCount.body.data).toBe(1);
    const exportAfterRestoration = await exportBusinessRows();
    expect(exportAfterRestoration.status).toBe(200);
    expect(exportAfterRestoration.headers['content-disposition']).toContain('Role%20revocation%20report_B.xlsx');
    expect(xlsx.parse(exportAfterRestoration.body)[0].data).toEqual([['Name'], ['Updated before role removal']]);
    const restoredUpdate = await apiAgent()
      .resource(collectionName)
      .update({ filterByTk: 1, values: { name: 'Updated after role restoration' } });
    expect(restoredUpdate.status).toBe(200);
    expect(restoredUpdate.body.data).toEqual([{ id: 1, name: 'Updated after role restoration', tenantId: 'B' }]);
    const restoredCreate = await apiAgent()
      .resource(collectionName)
      .create({ values: { name: 'After role restoration' } });
    expect(restoredCreate.status).toBe(200);
    expect(await rows()).toEqual([
      { id: 1, name: 'Updated after role restoration', tenantId: 'B' },
      { id: 2, name: 'After role restoration', tenantId: 'B' },
    ]);
  });
});

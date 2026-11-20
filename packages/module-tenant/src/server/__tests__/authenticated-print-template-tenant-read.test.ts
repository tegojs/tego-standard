import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import PrintTemplateServer from '../../../../plugin-prototype-print-template/src/server';
import { createTenantApp } from './utils';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

vi.mock('bullmq', () => ({
  Queue: class {
    add() {}
  },
  Worker: class {
    on() {}
  },
}));

describe.skipIf(!coreEntry)('authenticated print template tenant read boundary', () => {
  let app: Awaited<ReturnType<typeof createTenantApp>>;

  afterEach(async () => {
    await app?.destroy();
  });

  it('serves a PDF only when the authenticated user can read its tenant-scoped template', async () => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
    app = await createTenantApp({
      aclFactory: createACL,
      extraPlugins: [PrintTemplateServer],
      database: { dialect: 'sqlite', storage: ':memory:' },
    });
    await app.db.getRepository('tenants').create({
      values: [
        { id: 'print-template-B', name: 'Print template B', enabled: true },
        { id: 'print-template-C', name: 'Print template C', parentId: 'print-template-B', enabled: true },
      ],
    });

    const role = 'print-template-tenant-reader';
    const password = 'print-template-tenant-password';
    await app.db.getRepository('roles').create({
      values: { name: role, strategy: { actions: [] }, snippets: [] },
    });
    const user = await app.db.getRepository('users').create({
      values: {
        username: role,
        password,
        roles: [role],
        tenants: ['print-template-B'],
        defaultTenantId: 'print-template-B',
      },
    });

    await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: 'printTemplateFiles',
        timestamps: false,
        createdBy: false,
        updatedBy: false,
        fields: [
          { name: 'url', type: 'string' },
          { name: 'templateManageId', type: 'integer' },
        ],
      },
    });
    await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: 'templateManage',
        tenancy: 'tenantScoped',
        timestamps: false,
        createdBy: false,
        updatedBy: false,
        fields: [
          { name: 'pdf_SavePath', type: 'string' },
          { name: 'template', type: 'hasMany', target: 'printTemplateFiles', foreignKey: 'templateManageId' },
        ],
      },
    });

    const acl = app.acl as any;
    acl.define({
      role,
      actions: {
        'printTemplates:readPDF': {},
        'templateManage:get': { fields: ['id', 'pdf_SavePath', 'template'] },
      },
    });

    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'print-template-tenant-read-'));
    const bPdfPath = path.join(tempDirectory, 'tenant-b.pdf');
    const cPdfPath = path.join(tempDirectory, 'tenant-c.pdf');
    fs.writeFileSync(bPdfPath, 'tenant B PDF');
    fs.writeFileSync(cPdfPath, 'tenant C secret PDF');

    try {
      const templates = await app.db.getCollection('templateManage').model.bulkCreate([
        { pdf_SavePath: bPdfPath, tenantId: 'print-template-B' },
        { pdf_SavePath: cPdfPath, tenantId: 'print-template-C' },
      ]);
      const [bTemplate, cTemplate] = templates;
      await app.db.getRepository('printTemplateFiles').create({
        values: [
          { url: 'tenant-b.docx', templateManageId: bTemplate.get('id') },
          { url: 'tenant-c.docx', templateManageId: cTemplate.get('id') },
        ],
      });

      const signIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
        account: user.username,
        password,
      });
      expect(signIn.status).toBe(200);
      const agent = app
        .agent()
        .set('Authorization', `Bearer ${signIn.body.data.token}`)
        .set('X-Authenticator', 'basic')
        .set('X-Role', role)
        .set('X-Tenant-Id', 'print-template-B');

      const ownPdf = await agent.post('/printTemplates:readPDF').query({ id: bTemplate.get('id') });
      expect(ownPdf.status, JSON.stringify(ownPdf.body)).toBe(200);
      expect(ownPdf.body).toEqual(Buffer.from('tenant B PDF'));

      const foreignPdf = await agent.post('/printTemplates:readPDF').query({ id: cTemplate.get('id') });
      expect(foreignPdf.status).toBe(404);
      expect(foreignPdf.body).not.toEqual(Buffer.from('tenant C secret PDF'));

      await app.db.getRepository('collections').update({
        filterByTk: 'templateManage',
        values: { tenancy: 'tenantInherited' },
      });
      expect(app.db.getCollection('templateManage').options.tenancy).toBe('tenantInherited');
      const inheritedPdf = await agent.post('/printTemplates:readPDF').query({ id: cTemplate.get('id') });
      expect(inheritedPdf.status).toBe(200);
      expect(inheritedPdf.body).toEqual(Buffer.from('tenant C secret PDF'));
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });
});

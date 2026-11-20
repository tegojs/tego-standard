import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { vi } from 'vitest';

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
        tenancy: 'tenantScoped',
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
        'printTemplates:getTags': {},
        'printTemplateFiles:list': {},
        'templateManage:get': { fields: ['id', 'pdf_SavePath', 'template'] },
      },
    });

    const tempDirectory = fs.mkdtempSync(path.join(process.cwd(), '.tmp-print-template-tenant-read-'));
    const bPdfPath = path.join(tempDirectory, 'tenant-b.pdf');
    const cPdfPath = path.join(tempDirectory, 'tenant-c.pdf');
    fs.writeFileSync(bPdfPath, 'tenant B PDF');
    fs.writeFileSync(cPdfPath, 'tenant C secret PDF');

    const originalPwd = process.env.PWD;
    process.env.PWD = process.cwd();

    try {
      const templates = await app.db.getCollection('templateManage').model.bulkCreate([
        { pdf_SavePath: bPdfPath, tenantId: 'print-template-B' },
        { pdf_SavePath: cPdfPath, tenantId: 'print-template-C' },
      ]);
      const [bTemplate, cTemplate] = templates;
      await app.db.getCollection('printTemplateFiles').model.bulkCreate([
        { url: 'tenant-b.docx', tenantId: 'print-template-B', templateManageId: bTemplate.get('id') },
        { url: 'tenant-c.docx', tenantId: 'print-template-C', templateManageId: cTemplate.get('id') },
      ]);

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

      const [relatedOnlyToForeignFile] = await app.db
        .getCollection('templateManage')
        .model.bulkCreate([{ pdf_SavePath: bPdfPath, tenantId: 'print-template-B' }]);
      const foreignTemplatePath = path.join(tempDirectory, 'foreign-tenant-template.docx');
      fs.writeFileSync(foreignTemplatePath, 'foreign tenant template bytes');
      await app.db.getCollection('printTemplateFiles').model.create({
        url: path.relative(process.env.PWD || process.cwd(), foreignTemplatePath),
        tenantId: 'print-template-C',
        templateManageId: relatedOnlyToForeignFile.get('id'),
      });

      const fileReadSpy = vi.spyOn(fs, 'readFileSync');
      const tagsResponse = await agent
        .post('/printTemplates:getTags')
        .query({ id: relatedOnlyToForeignFile.get('id') });
      const readPaths = fileReadSpy.mock.calls.map(([file]) => path.resolve(String(file)));
      fileReadSpy.mockRestore();
      expect(readPaths).not.toContain(path.resolve(foreignTemplatePath));
      expect(tagsResponse.status).toBe(404);
    } finally {
      if (originalPwd === undefined) {
        delete process.env.PWD;
      } else {
        process.env.PWD = originalPwd;
      }
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });
});

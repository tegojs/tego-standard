import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ACL, Resourcer } from '@tego/server';

import { describe, expect, it, vi } from 'vitest';

import { readPDF } from '../actions/printTemplates';
import { addConversionJob } from '../actions/producer';
import { PluginPrintTemplateServer } from '../plugin';

vi.mock('bullmq', () => ({
  Queue: class {
    add() {}
  },
  Worker: class {
    on() {}
  },
}));

describe('print template action access', () => {
  it('does not bypass ACL for anonymous read and conversion actions', async () => {
    const acl = new ACL();
    const app = {
      acl,
      resourcer: { define: vi.fn() },
      use: vi.fn(),
    };
    await PluginPrintTemplateServer.prototype.load.call({ app } as any);

    const isAllowed = (action: string, currentUser?: { id: number }) =>
      (acl as any).allowManager.isAllowed('printTemplates', action, { state: { currentUser } });

    for (const action of ['generate', 'getTags', 'addConversionJob', 'readPDF']) {
      await expect(isAllowed(action)).resolves.toBe(false);
    }

    acl.define({ role: 'print-template-user', actions: { 'printTemplates:generate': {} } });
    expect(
      acl.can({
        role: 'print-template-user',
        resource: 'printTemplates',
        action: 'generate',
        rawResourceName: 'printTemplates',
        ctx: { state: { currentRole: 'print-template-user' } },
      }),
    ).not.toBeNull();
  });

  it('does not read a template when the current role lacks templateManage get permission', async () => {
    const acl = new ACL();
    const role = 'print-template-reader';
    acl.define({ role, actions: { 'printTemplates:readPDF': {} } });
    expect(acl.can({ role, resource: 'templateManage', action: 'get' })).toBeNull();

    const fileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'print-template-acl-'));
    const filePath = path.join(fileDirectory, 'private.pdf');
    fs.writeFileSync(filePath, 'private tenant document');

    const resourcer = new Resourcer();
    resourcer.use(acl.middleware(), { tag: 'acl' });
    resourcer.define({ name: 'printTemplates', actions: { readPDF } });
    const action = resourcer.getAction('printTemplates', 'readPDF');
    Object.assign(action, { resourceName: 'printTemplates', actionName: 'readPDF' });
    action.params.id = 47;

    const repository = {
      findOne: vi.fn().mockResolvedValue({ get: () => ({ pdf_SavePath: filePath }) }),
    };
    const context = {
      state: { currentRole: role },
      db: { getRepository: vi.fn(() => repository) },
      throw(status: number) {
        const error = new Error('Forbidden') as Error & { status: number };
        error.status = status;
        throw error;
      },
    };

    try {
      await expect(
        resourcer.execute({ resource: 'printTemplates', action: 'readPDF' }, context as any),
      ).rejects.toMatchObject({ status: 403 });
      expect(repository.findOne).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(fileDirectory, { recursive: true, force: true });
    }
  });

  it('preserves the template read denial when starting a conversion job', async () => {
    const acl = new ACL();
    const role = 'print-template-job-reader';
    acl.define({ role, actions: { 'printTemplates:addConversionJob': {} } });

    const resourcer = new Resourcer();
    resourcer.use(acl.middleware(), { tag: 'acl' });
    resourcer.define({ name: 'printTemplates', actions: { addConversionJob } });
    const action = resourcer.getAction('printTemplates', 'addConversionJob');
    Object.assign(action, { resourceName: 'printTemplates', actionName: 'addConversionJob' });
    action.params.id = 47;

    const repository = { findOne: vi.fn() };
    const context: Record<string, any> = {
      state: { currentRole: role },
      db: { getRepository: vi.fn(() => repository) },
      throw(status: number) {
        const error = new Error('Forbidden') as Error & { status: number };
        error.status = status;
        throw error;
      },
    };

    await expect(
      resourcer.execute({ resource: 'printTemplates', action: 'addConversionJob' }, context),
    ).rejects.toMatchObject({ status: 403 });

    expect(repository.findOne).not.toHaveBeenCalled();
  });

  it('keeps the templateManage ACL filter on the PDF repository lookup', async () => {
    const acl = new ACL();
    const role = 'print-template-scoped-reader';
    const scopeFilter = { tenantId: '{{ ctx.state.currentTenant.id }}' };
    const fixedParams = vi.fn(() => ({ filter: scopeFilter }));
    acl.define({ role, actions: { 'printTemplates:readPDF': {}, 'templateManage:get': {} } });
    acl.addFixedParams('templateManage', 'get', fixedParams);

    const fileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'print-template-acl-scope-'));
    const filePath = path.join(fileDirectory, 'private.pdf');
    fs.writeFileSync(filePath, 'tenant B document');

    const resourcer = new Resourcer();
    resourcer.use(acl.middleware(), { tag: 'acl' });
    resourcer.define({ name: 'printTemplates', actions: { readPDF } });
    const action = resourcer.getAction('printTemplates', 'readPDF');
    Object.assign(action, { resourceName: 'printTemplates', actionName: 'readPDF' });
    action.params.id = 47;

    const repository = {
      findOne: vi.fn().mockResolvedValue({ get: () => ({ pdf_SavePath: filePath }) }),
    };
    const context: Record<string, any> = {
      state: { currentRole: role, currentTenant: { id: 'B' } },
      db: { getRepository: vi.fn(() => repository) },
    };

    try {
      await resourcer.execute({ resource: 'printTemplates', action: 'readPDF' }, context as any);
      expect(fixedParams).toHaveBeenCalledTimes(1);
      expect(repository.findOne).toHaveBeenCalledWith({
        filter: { $and: [{ id: 47 }, scopeFilter] },
        context,
      });
      expect(context.body).toEqual(Buffer.from('tenant B document'));
    } finally {
      fs.rmSync(fileDirectory, { recursive: true, force: true });
    }
  });

  it('does not read the PDF path when templateManage ACL excludes that field', async () => {
    const acl = new ACL();
    const role = 'print-template-limited-reader';
    acl.define({
      role,
      actions: { 'printTemplates:readPDF': {}, 'templateManage:get': { fields: ['id'] } },
    });
    expect(acl.can({ role, resource: 'templateManage', action: 'get' })?.params.fields).toEqual(['id']);

    const fileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'print-template-acl-fields-'));
    const filePath = path.join(fileDirectory, 'private.pdf');
    fs.writeFileSync(filePath, 'restricted document');

    const resourcer = new Resourcer();
    resourcer.use(acl.middleware(), { tag: 'acl' });
    resourcer.define({ name: 'printTemplates', actions: { readPDF } });
    const action = resourcer.getAction('printTemplates', 'readPDF');
    Object.assign(action, { resourceName: 'printTemplates', actionName: 'readPDF' });
    action.params.id = 47;

    const repository = {
      findOne: vi.fn().mockResolvedValue({ get: () => ({ pdf_SavePath: filePath }) }),
    };
    const context = {
      state: { currentRole: role },
      db: { getRepository: vi.fn(() => repository) },
      throw(status: number) {
        const error = new Error('Forbidden') as Error & { status: number };
        error.status = status;
        throw error;
      },
    };

    try {
      await expect(
        resourcer.execute({ resource: 'printTemplates', action: 'readPDF' }, context as any),
      ).rejects.toMatchObject({ status: 403 });
      expect(repository.findOne).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(fileDirectory, { recursive: true, force: true });
    }
  });
});

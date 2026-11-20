import { ACL } from '@tego/server';

import { describe, expect, it, vi } from 'vitest';

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
});

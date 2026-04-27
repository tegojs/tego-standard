import React from 'react';
import { Application } from '@tachybase/client';
import { render, waitFor } from '@tachybase/test/client';

import PluginTenantClient from '..';
import CurrentTenantProvider from '../CurrentTenantProvider';
import { TenantEditor, TenantManagement } from '../TenantManagement';
import TenantMenuProvider from '../TenantMenuProvider';

describe('PluginTenantClient', () => {
  it('should register tenant providers on load', async () => {
    const app = new Application({
      plugins: [[PluginTenantClient, { name: 'tenant' }]],
    });

    await app.load();

    expect(app.providers).toEqual(
      expect.arrayContaining([
        [CurrentTenantProvider, undefined],
        [TenantMenuProvider, undefined],
      ]),
    );
  });

  it('should register tenant management entry in system settings', async () => {
    const app = new Application({
      plugins: [[PluginTenantClient, { name: 'tenant' }]],
    });

    await app.load();

    expect(app.systemSettingsManager.get('id-auth.tenants')).toMatchObject({
      aclSnippet: 'pm.tenant.manage',
      Component: TenantManagement,
    });
  });

  it('should sync tenant editor values when initial record changes', async () => {
    const noop = async () => {};
    const { rerender, container } = render(
      <TenantEditor
        initialValues={{
          name: 'tenant_a',
          title: 'Tenant A',
          enabled: true,
        }}
        loading={false}
        open
        title="Edit tenant"
        onClose={() => {}}
        onSubmit={noop}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('input[id="name"]')).toHaveValue('tenant_a');
      expect(container.querySelector('input[id="title"]')).toHaveValue('Tenant A');
    });

    rerender(
      <TenantEditor
        initialValues={{
          name: 'tenant_b',
          title: 'Tenant B',
          enabled: false,
        }}
        loading={false}
        open
        title="Edit tenant"
        onClose={() => {}}
        onSubmit={noop}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('input[id="name"]')).toHaveValue('tenant_b');
      expect(container.querySelector('input[id="title"]')).toHaveValue('Tenant B');
    });
  });
});

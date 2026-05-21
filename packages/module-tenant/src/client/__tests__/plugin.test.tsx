import React from 'react';
import { Application, CurrentNavigationMenuProvider, useCurrentNavigationMenu } from '@tachybase/client';
import { render, waitFor } from '@tachybase/test/client';

import PluginTenantClient from '..';
import CurrentTenantProvider, { CurrentTenantContext } from '../CurrentTenantProvider';
import { NAMESPACE, useTenantTranslation } from '../locale';
import { TenantEditor, TenantManagement } from '../TenantManagement';
import TenantMenuProvider from '../TenantMenuProvider';

describe('PluginTenantClient', () => {
  it('should render tenant switcher in the navigation extension area', async () => {
    const NavigationItems = () => {
      const { getItems } = useCurrentNavigationMenu();
      return <>{getItems().map((item) => React.cloneElement(item, { key: item.key }))}</>;
    };

    const { container } = render(
      <CurrentTenantContext.Provider
        value={{
          data: {
            data: [
              { id: 'tenant_a', title: 'Tenant A', current: true },
              { id: 'tenant_b', title: 'Tenant B' },
            ],
          },
        }}
      >
        <CurrentNavigationMenuProvider>
          <TenantMenuProvider>
            <NavigationItems />
          </TenantMenuProvider>
        </CurrentNavigationMenuProvider>
      </CurrentTenantContext.Provider>,
    );

    await waitFor(() => {
      expect(container.querySelector('.tenant-nav-switcher')).toBeInTheDocument();
      expect(container.querySelector('.tenant-nav-switcher .ant-select')).toHaveStyle({ minWidth: 'auto' });
    });
  });

  it('should not register tenant switcher in the user settings menu', async () => {
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

  it('should expose tenant translation hook with t function', () => {
    const TranslationProbe = () => {
      const { t } = useTenantTranslation();
      return <span data-testid="tenant-text">{t('Tenants')}</span>;
    };

    const { getByTestId } = render(<TranslationProbe />);

    expect(NAMESPACE).toBe('tenant');
    expect(getByTestId('tenant-text')).toHaveTextContent('Tenants');
  });

  it('should sync tenant editor values when initial record changes', async () => {
    const noop = async () => {};
    const { rerender, container } = render(
      <TenantEditor
        initialValues={{
          name: 'tenant_a',
          title: 'Tenant A',
          enabled: true,
          parentId: 'root',
        }}
        parentOptions={[{ label: 'Root', value: 'root' }]}
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
          parentId: undefined,
        }}
        parentOptions={[{ label: 'Root', value: 'root' }]}
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

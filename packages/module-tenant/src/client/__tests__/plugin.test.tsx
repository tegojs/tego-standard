import React from 'react';
import { Application, CurrentNavigationMenuProvider, i18n, useCurrentNavigationMenu } from '@tachybase/client';
import { render, waitFor } from '@tachybase/test/client';

import PluginTenantClient from '..';
import zhCN from '../../locale/zh-CN.json';
import CurrentTenantProvider, { CurrentTenantContext } from '../CurrentTenantProvider';
import { NAMESPACE, useTenantTranslation } from '../locale';
import {
  buildUserSearchFilter,
  getTenantCandidateOptions,
  getTenantMembers,
  TenantEditor,
  TenantManagement,
} from '../TenantManagement';
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

  it('should build broad user search filter for tenant member picker', () => {
    expect(buildUserSearchFilter('tom')).toEqual({
      $or: [
        { 'username.$includes': 'tom' },
        { 'nickname.$includes': 'tom' },
        { 'email.$includes': 'tom' },
        { 'phone.$includes': 'tom' },
      ],
    });

    expect(buildUserSearchFilter('42')).toEqual({
      $or: [
        { 'username.$includes': '42' },
        { 'nickname.$includes': '42' },
        { 'email.$includes': '42' },
        { 'phone.$includes': '42' },
        { id: 42 },
      ],
    });
  });

  it('should separate current tenant members from add-member candidates', () => {
    const users = [
      {
        id: 1,
        username: 'current_user',
        email: 'current@example.com',
        tenants: [{ id: 'tenant-a', title: 'Tenant A' }],
      },
      {
        id: 2,
        username: 'candidate_user',
        email: 'candidate@example.com',
        tenants: [{ id: 'tenant-b', title: 'Tenant B' }],
      },
    ];

    expect(getTenantMembers(users, 'tenant-a')).toEqual([users[0]]);
    expect(getTenantCandidateOptions(users, 'tenant-a')).toEqual([
      {
        label: 'candidate_user · candidate@example.com',
        value: 2,
      },
    ]);
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

  it('should expose tenant translation hook with t function', async () => {
    i18n.addResources('zh-CN', NAMESPACE, zhCN);
    await i18n.changeLanguage('zh-CN');

    try {
      const TranslationProbe = () => {
        const { t } = useTenantTranslation();
        return <span data-testid="tenant-text">{t('Tenants')}</span>;
      };

      const { getByTestId } = render(<TranslationProbe />);

      expect(NAMESPACE).toBe('tenant');
      expect(zhCN.Tenants).toBe('租户');
      expect(getByTestId('tenant-text')).toHaveTextContent('租户');
    } finally {
      await i18n.changeLanguage('en-US');
    }
  });

  it('should sync tenant editor values when initial record changes', async () => {
    const noop = async () => {};
    const { rerender } = render(
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
      expect(document.querySelector('input[id="name"]')).toHaveValue('tenant_a');
      expect(document.querySelector('input[id="title"]')).toHaveValue('Tenant A');
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
      expect(document.querySelector('input[id="name"]')).toHaveValue('tenant_b');
      expect(document.querySelector('input[id="title"]')).toHaveValue('Tenant B');
    });
  });
});

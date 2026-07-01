import React from 'react';
import {
  Application,
  CollectionTemplate,
  CurrentNavigationMenuProvider,
  i18n,
  Plugin,
  useCurrentNavigationMenu,
} from '@tachybase/client';
import { render, waitFor } from '@tachybase/test/client';

import { vi } from 'vitest';

import PluginTenantClient from '..';
import zhCN from '../../locale/zh-CN.json';
import CurrentTenantProvider, { CurrentTenantContext } from '../CurrentTenantProvider';
import { loadLegacyDataTenantOptions } from '../LegacyDataTenantSelect';
import { NAMESPACE, useTenantTranslation } from '../locale';
import {
  buildTenantCandidateFilter,
  buildTenantMemberFilter,
  buildUserSearchFilter,
  getTenantCandidateOptions,
  getTenantMembers,
  TenantEditor,
  TenantManagement,
} from '../TenantManagement';
import TenantMenuProvider from '../TenantMenuProvider';

/** Stub templates for testing injection logic. */
class StubGeneralTemplate extends CollectionTemplate {
  name = 'general';
  configurableProperties = {} as any;
}
class StubExpressionTemplate extends CollectionTemplate {
  name = 'expression';
  configurableProperties = {} as any;
}
class StubTreeTemplate extends CollectionTemplate {
  name = 'tree';
  configurableProperties = {} as any;
}
class StubSqlTemplate extends CollectionTemplate {
  name = 'sql';
  configurableProperties = {
    config: {
      properties: {
        sql: {},
      },
    },
  } as any;
}
class StubViewTemplate extends CollectionTemplate {
  name = 'view';
  configurableProperties = {
    databaseView: {},
  } as any;
}
class StubWorkflowPlugin extends Plugin {
  sqlInstruction = {
    fieldset: {
      sql: {},
    },
  };
  instructions = {
    get: (type: string) => (type === 'sql' ? this.sqlInstruction : undefined),
  };
}

function createAppWithTemplates() {
  return new Application({
    plugins: [[PluginTenantClient, { name: 'tenant' }]],
    dataSourceManager: {
      collectionTemplates: [
        StubGeneralTemplate,
        StubExpressionTemplate,
        StubTreeTemplate,
        StubSqlTemplate,
        StubViewTemplate,
      ],
    },
  });
}

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

  it('should remove tenant switcher when available tenants shrink to one', async () => {
    const NavigationItems = () => {
      const { getItems } = useCurrentNavigationMenu();
      return <>{getItems().map((item) => React.cloneElement(item, { key: item.key }))}</>;
    };

    const { container, rerender } = render(
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
    });

    rerender(
      <CurrentTenantContext.Provider
        value={{
          data: {
            data: [{ id: 'tenant_a', title: 'Tenant A', current: true }],
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
      expect(container.querySelector('.tenant-nav-switcher')).not.toBeInTheDocument();
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

  it('should keep current tenant provider hook order when currentUser prop changes', async () => {
    const currentUser = { data: { data: {} } };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const { rerender } = render(
        <CurrentTenantProvider currentUser={currentUser}>
          <span>tenant-provider</span>
        </CurrentTenantProvider>,
      );

      rerender(
        <CurrentTenantProvider>
          <span>tenant-provider</span>
        </CurrentTenantProvider>,
      );

      const hookOrderWarnings = consoleError.mock.calls.filter(([message]) =>
        String(message).includes('change in the order of Hooks'),
      );
      expect(hookOrderWarnings).toHaveLength(0);
    } finally {
      consoleError.mockRestore();
    }
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

  it('should build server-side tenant member and candidate filters', () => {
    expect(buildTenantMemberFilter('tenant-a', 'tom')).toEqual({
      $and: [
        { 'tenants.id': 'tenant-a' },
        {
          $or: [
            { 'username.$includes': 'tom' },
            { 'nickname.$includes': 'tom' },
            { 'email.$includes': 'tom' },
            { 'phone.$includes': 'tom' },
          ],
        },
      ],
    });

    expect(buildTenantCandidateFilter([1, 2], '42')).toEqual({
      $and: [
        { 'id.$notIn': [1, 2] },
        {
          $or: [
            { 'username.$includes': '42' },
            { 'nickname.$includes': '42' },
            { 'email.$includes': '42' },
            { 'phone.$includes': '42' },
            { id: 42 },
          ],
        },
      ],
    });
  });

  it('should load all tenant option pages for legacy data tenant selector', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          data: Array.from({ length: 2 }, (_, index) => ({ id: `tenant-${index + 1}` })),
        },
      })
      .mockResolvedValueOnce({
        data: {
          data: [{ id: 'tenant-3', title: 'Tenant 3' }],
        },
      });
    const api = {
      resource: vi.fn(() => ({ list })),
    };

    const options = await loadLegacyDataTenantOptions(api, () => false, 2);

    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenNthCalledWith(1, { page: 1, pageSize: 2 });
    expect(list).toHaveBeenNthCalledWith(2, { page: 2, pageSize: 2 });
    expect(options).toEqual([
      { label: 'tenant-1', value: 'tenant-1' },
      { label: 'tenant-2', value: 'tenant-2' },
      { label: 'Tenant 3', value: 'tenant-3' },
    ]);
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

  it('should inject tenancy fields into standard collection templates on load', async () => {
    const app = createAppWithTemplates();

    await app.load();

    const ctm = app.dataSourceManager.collectionTemplateManager;
    for (const name of ['general', 'expression', 'tree']) {
      const tpl = ctm.getCollectionTemplate(name);
      expect(tpl.configurableProperties.tenancy).toMatchObject({
        type: 'string',
        'x-component': 'Select',
      });
      expect(tpl.configurableProperties.tenancy.enum).toEqual([
        { label: '{{t("Shared collection")}}', value: 'shared' },
        { label: '{{t("Tenant scoped")}}', value: 'tenantScoped' },
        { label: '{{t("Tenant inherited")}}', value: 'tenantInherited' },
      ]);
      expect(tpl.configurableProperties.legacyDataTenantIds).toMatchObject({
        type: 'array',
        name: 'legacyDataTenantIds',
        'x-component': 'LegacyDataTenantSelect',
        'x-component-props': {
          mode: 'multiple',
        },
      });
    }
  });

  it('should not inject tenancy fields into SQL or view templates', async () => {
    const app = createAppWithTemplates();

    await app.load();

    const ctm = app.dataSourceManager.collectionTemplateManager;
    for (const name of ['sql', 'view']) {
      const tpl = ctm.getCollectionTemplate(name);
      expect(tpl.configurableProperties.tenancy).toBeUndefined();
      expect(tpl.configurableProperties.legacyDataTenantIds).toBeUndefined();
    }
  });

  it('should inject tenant warnings into SQL and view templates on load', async () => {
    const app = createAppWithTemplates();

    await app.load();

    const ctm = app.dataSourceManager.collectionTemplateManager;
    expect(ctm.getCollectionTemplate('sql').configurableProperties.config.properties.sql.description).toContain(
      'SQL_COLLECTION_TENANT_ISOLATION_WARNING',
    );
    expect(ctm.getCollectionTemplate('view').configurableProperties.databaseView.description).toContain(
      'VIEW_COLLECTION_TENANT_ISOLATION_WARNING',
    );
  });

  it('should inject tenant warning into workflow SQL instruction when workflow is enabled', async () => {
    const app = new Application({
      plugins: [
        [StubWorkflowPlugin, { name: 'workflow' }],
        [PluginTenantClient, { name: 'tenant' }],
      ],
    });

    await app.load();

    const workflow = app.pm.get('workflow') as StubWorkflowPlugin;
    expect(workflow.sqlInstruction.fieldset.sql.description).toContain('SQL_NODE_TENANT_ISOLATION_WARNING');
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

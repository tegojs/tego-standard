import React from 'react';
import { render } from '@tachybase/test/client';

import { AdminSettingsLayout } from '../AdminSettings';

const mocks = vi.hoisted(() => ({
  route: undefined as any,
  settings: [] as any[],
}));

vi.mock('../../../application', () => ({
  ADMIN_SETTINGS_PATH: '/_admin/',
  useApp: () => ({
    systemSettingsManager: {
      getList: () => structuredClone(mocks.settings),
    },
  }),
}));

vi.mock('../../../schema-component', () => ({
  useCompile: () => (value: unknown) => value,
}));

vi.mock('react-router-dom', () => ({
  Navigate: () => null,
  Outlet: () => null,
  useLocation: () => ({ pathname: '/_admin/id-auth/tenants' }),
  useNavigate: () => vi.fn(),
}));

vi.mock('../SettingLayout', () => ({
  SettingLayout: ({ route, children }: any) => {
    mocks.route = route;
    return <>{children}</>;
  },
}));

const tenantSetting = (children: any[]) => ({
  key: 'id-auth.tenants',
  name: 'id-auth.tenants',
  path: '/_admin/id-auth/tenants',
  title: 'Tenants',
  children,
});

describe('AdminSettingsLayout menu', () => {
  beforeEach(() => {
    mocks.route = undefined;
  });

  it('should not make a setting expandable when all of its children are hidden', () => {
    mocks.settings = [
      tenantSetting([
        {
          key: 'id-auth.tenants.impersonate',
          path: '/_admin/id-auth/tenants/impersonate',
          title: 'Tenant impersonation',
          hideInMenu: true,
        },
      ]),
    ];

    render(<AdminSettingsLayout />);

    expect(mocks.route.children[0]).not.toHaveProperty('children');
  });

  it('should keep visible children while removing hidden children', () => {
    mocks.settings = [
      tenantSetting([
        {
          key: 'id-auth.tenants.visible',
          path: '/_admin/id-auth/tenants/visible',
          title: 'Visible child',
        },
        {
          key: 'id-auth.tenants.impersonate',
          path: '/_admin/id-auth/tenants/impersonate',
          title: 'Tenant impersonation',
          hideInMenu: true,
        },
      ]),
    ];

    render(<AdminSettingsLayout />);

    expect(mocks.route.children[0].children).toHaveLength(1);
    expect(mocks.route.children[0].children[0].key).toBe('id-auth.tenants.visible');
  });
});

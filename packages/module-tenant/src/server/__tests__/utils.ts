import { createMockServer, MockServer } from '@tachybase/test';

import PluginTenantServer from '..';

export async function createTenantApp(): Promise<MockServer> {
  return createMockServer({
    registerActions: true,
    acl: true,
    plugins: [
      'acl',
      'error-handler',
      'users',
      'ui-schema-storage',
      'collection-manager',
      'auth',
      'data-source-manager',
      [PluginTenantServer, { name: 'tenant', packageName: '@tachybase/module-tenant' }],
    ],
  });
}

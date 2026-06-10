import { createMockServer, MockServer } from '@tachybase/test';

export const aclTestPlugins = [
  'acl',
  'error-handler',
  'users',
  'ui-schema-storage',
  'collection-manager',
  'auth',
  'data-source-manager',
];

export const aclLightTestPlugins = ['acl', 'error-handler', 'users', 'auth', 'data-source-manager'];

export const aclCollectionManagerTestPlugins = [...aclLightTestPlugins, 'collection-manager'];

export const aclRoleCheckTestPlugins = [...aclLightTestPlugins, 'ui-schema-storage'];

export async function prepareApp(options: { plugins?: any[] } = {}): Promise<MockServer> {
  const app = await createMockServer({
    registerActions: true,
    acl: true,
    plugins: options.plugins ?? aclTestPlugins,
  });
  return app;
}

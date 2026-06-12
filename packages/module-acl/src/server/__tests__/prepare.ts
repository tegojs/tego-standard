import { createMockServer, MockServer } from '@tachybase/test';

export const aclTestPlugins = [
  'acl',
  'error-handler',
  'users',
  'ui-schema-storage',
  'collection-manager',
  'auth',
  'data-source-manager',
] as const;

export const aclLightTestPlugins = ['acl', 'error-handler', 'users', 'auth', 'data-source-manager'] as const;

export const aclCollectionManagerTestPlugins = [...aclLightTestPlugins, 'collection-manager'] as const;

export const aclRoleCheckTestPlugins = [...aclLightTestPlugins, 'ui-schema-storage'] as const;

export async function prepareApp(options: { plugins?: readonly string[] } = {}): Promise<MockServer> {
  const app = await createMockServer({
    registerActions: true,
    acl: true,
    plugins: [...(options.plugins ?? aclTestPlugins)],
  });
  return app;
}

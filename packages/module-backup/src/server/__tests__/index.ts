import { createMockServer } from '@tachybase/test';

export const backupTestPlugins = [
  'error-handler',
  'collection',
  'users',
  'auth',
  'acl',
  'data-source-manager',
  'backup',
  'audit-logs',
  'sequence-field',
  'block-map',
];

export const backupBaseTestPlugins = ['error-handler', 'collection', 'data-source-manager', 'backup'];

export default async function createApp(options: { plugins?: string[] } = {}) {
  const app = await createMockServer({
    plugins: options.plugins || backupTestPlugins,
  });
  return app;
}

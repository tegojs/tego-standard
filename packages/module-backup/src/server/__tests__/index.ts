import { createMockServer } from '@tachybase/test';

export default async function createApp() {
  const app = await createMockServer({
    plugins: [
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
    ],
  });
  return app;
}

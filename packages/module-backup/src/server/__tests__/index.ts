import { createMockServer } from '@tachybase/test';

export default async function createApp() {
  const app = await createMockServer({
    plugins: ['error-handler', 'collection', 'users', 'auth', 'acl', 'data-source-manager', 'backup'],
  });
  return app;
}

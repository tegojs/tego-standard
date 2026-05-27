import fs from 'node:fs';
import path from 'node:path';
import { createMockServer, MockServer } from '@tachybase/test';

import PluginTenantServer from 'packages/module-tenant/src/server';
import supertest from 'supertest';

import usersCollection from './tables/users';

export async function getApp(options = {}): Promise<MockServer> {
  const app = await createMockServer({
    ...options,
    cors: {
      origin: '*',
    },
    registerActions: true,
    plugins: [
      'acl',
      'users',
      'collection-manager',
      'error-handler',
      'auth',
      'data-source-manager',
      'file-manager',
      [PluginTenantServer, { name: 'tenant', packageName: '@tachybase/module-tenant' }],
    ],
    acl: false,
  });

  app.use(async (ctx, next) => {
    if (ctx.path.startsWith('/storage/uploads')) {
      const filePath = path.resolve(process.env.TEGO_RUNTIME_HOME || process.cwd(), `.${ctx.path}`);
      ctx.type = path.extname(filePath);
      ctx.body = fs.createReadStream(filePath);
      return;
    }
    await next();
  });

  app.db.collection(usersCollection);

  await app.db.sync();

  return app;
}

// because the app in supertest will use a random port
export function requestFile(url, agent) {
  // url starts with double slash "//" will be considered as http or https
  // url starts with single slash "/" will be considered from local server
  return url[0] === '/' && url[1] !== '/' ? agent.get(url) : supertest.agent(url).get('');
}

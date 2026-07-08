import path from 'node:path';
import { createMockServer, MockServer } from '@tachybase/test';

import send from 'koa-send';
import supertest from 'supertest';

import usersCollection from './tables/users';

export async function getApp(options = {}): Promise<MockServer> {
  const app = await createMockServer({
    ...options,
    cors: {
      origin: '*',
    },
    plugins: ['file-manager'],
    acl: false,
  });

  app.use(async (ctx, next) => {
    if (ctx.path.startsWith('/storage/uploads')) {
      await send(ctx, ctx.path, { root: process.env.TEGO_RUNTIME_HOME || process.cwd() });
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

import { createMockServer, MockServer } from '@tachybase/test';
import { ApplicationOptions } from '@tego/server';

import authorsCollection from './collections/authors';

export function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface MockAppOptions extends ApplicationOptions {
  manual?: boolean;
}

export async function getApp(options: MockAppOptions = {}): Promise<MockServer> {
  const app = await createMockServer({
    ...options,
    plugins: ['verification'],
  });

  app.db.collection(authorsCollection);

  try {
    await app.db.sync();
  } catch (error) {
    console.error(error);
  }

  return app;
}

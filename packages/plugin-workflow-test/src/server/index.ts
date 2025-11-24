import path from 'node:path';
import { createMockServer, mockDatabase, MockServer } from '@tachybase/test';
import { ApplicationOptions, Plugin, Resourcer, SequelizeDataSource, uid } from '@tego/server';

import functions from './functions';
import instructions from './instructions';
import triggers from './triggers';

export interface MockServerOptions extends ApplicationOptions {
  collectionsPath?: string;
}

// async function createMockServer(options: MockServerOptions) {
//   const app = mockServer(options);
//   await app.cleanDb();
//   await app.runCommand('start', '--quickstart');
//   return app;
// }

export function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function getApp(options: MockServerOptions = {}): Promise<MockServer> {
  const { plugins = [], collectionsPath, ...others } = options;
  class TestCollectionPlugin extends Plugin {
    async load() {
      if (collectionsPath) {
        await this.db.import({ directory: collectionsPath });
      }
    }
  }
  const app = await createMockServer({
    ...others,
    plugins: [
      [
        'workflow',
        {
          triggers,
          instructions,
          functions,
        },
      ],
      'workflow-test',
      TestCollectionPlugin,
      ...plugins,
    ],
  });

  await app.dataSourceManager.add(
    new SequelizeDataSource({
      name: 'another',
      collectionManager: {
        database: mockDatabase({
          tablePrefix: `t${uid(5)}`,
        }),
      },
      resourceManager: {},
    }),
  );
  const another = app.dataSourceManager.dataSources.get('another');
  // @ts-ignore
  const anotherDB = another.collectionManager.db;

  await anotherDB.import({
    directory: path.resolve(__dirname, 'collections'),
  });
  await anotherDB.sync();

  another.acl.allow('*', '*');

  return app;
}

export default class WorkflowTestPlugin extends Plugin {
  async load() {}
}

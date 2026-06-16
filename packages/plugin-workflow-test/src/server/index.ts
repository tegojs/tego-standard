import fs from 'node:fs';
import path from 'node:path';
import { createMockServer, type MockServer } from '@tachybase/test';
import { ApplicationOptions, mockDatabase, Plugin, Resourcer, SequelizeDataSource, uid } from '@tego/server';

import functions from './functions';
import instructions from './instructions';
import triggers from './triggers';

export interface MockServerOptions extends ApplicationOptions {
  collectionsPath?: string;
  withAnotherDataSource?: boolean;
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
  const { plugins = [], collectionsPath, withAnotherDataSource = false, ...others } = options;
  const defaultCollectionsPath = path.resolve(__dirname, 'collections');
  const compiledCollectionsPath = path.resolve(__dirname, '../../dist/server/collections');
  const resolvedCollectionsPath =
    collectionsPath || (fs.existsSync(compiledCollectionsPath) ? compiledCollectionsPath : defaultCollectionsPath);

  class TestCollectionPlugin extends Plugin {
    async load() {
      if (resolvedCollectionsPath) {
        await this.db.import({ directory: resolvedCollectionsPath });
      }
    }
  }
  class TestAuthStatusPlugin extends Plugin {
    async load() {
      if (!this.app.authManager.userStatusService) {
        this.app.authManager.setUserStatusService({
          async checkUserStatus() {
            return {
              allowed: true,
              status: 'active',
              statusInfo: {
                title: 'Active',
                color: 'green',
                allowLogin: true,
              },
              errorMessage: '',
              isExpired: false,
            };
          },
          async setUserStatusCache() {},
          async getUserStatusFromCache() {
            return null;
          },
          getUserStatusCacheKey(userId: number) {
            return `test-user-status:${userId}`;
          },
          async restoreUserStatus() {},
          async clearUserStatusCache() {},
          async recordStatusHistoryIfNotExists() {},
        });
      }
    }
  }
  const app = await createMockServer({
    ...others,
    plugins: [
      'error-handler',
      'collection',
      'user',
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
      TestAuthStatusPlugin,
    ],
  });

  if (withAnotherDataSource) {
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
      directory: resolvedCollectionsPath,
    });
    await anotherDB.sync();

    another.acl.allow('*', '*');
  }

  return app;
}

export default class WorkflowTestPlugin extends Plugin {}

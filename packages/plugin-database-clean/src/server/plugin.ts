import { Plugin } from '@tego/server';

import databaseCleanResourcer from './resourcers/database-clean';
import { FileLock } from './utils/lock';

export class PluginPluginDatabaseClean extends Plugin {
  async afterAdd() {}

  async beforeLoad() {
    // 注册 ACL snippet
    this.app.acl.registerSnippet({
      name: 'pm.database-clean.*',
      actions: ['databaseClean:*'],
    });
  }

  async load() {
    // 注册 API 路由
    this.app.resourcer.define(databaseCleanResourcer);

    // 清理过期锁（应用启动时）
    const lock = new FileLock(this.app.db);
    await lock.cleanExpiredLocks();
  }

  async install() {}

  async afterEnable() {}

  async afterDisable() {}

  async remove() {}
}

export default PluginPluginDatabaseClean;

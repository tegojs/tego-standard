import { resolve } from 'node:path';
import { InjectedPlugin, Plugin } from '@tego/server';

import { AuthMainAppController } from './actions/authMainApp';
import { AuthMainAppService } from './service/authMainAppService';

@InjectedPlugin({
  Controllers: [AuthMainAppController],
  Services: [AuthMainAppService],
})
export class PluginAuthMainAppServer extends Plugin {
  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    // 如果基类的 loadCollections() 没有导入 collections（packageName 未设置），手动导入
    const collectionsDir = resolve(__dirname, 'collections');
    const authMainAppConfigCollection = this.db.getCollection('authMainAppConfig');
    if (!authMainAppConfigCollection) {
      await this.db.import({
        directory: collectionsDir,
        from: this.options.packageName || '@tachybase/plugin-auth-main-app',
      });
    }
  }

  async install() {}

  async afterEnable() {}

  async afterDisable() {}

  async remove() {}
}

export default PluginAuthMainAppServer;

import { InjectedPlugin, Plugin } from '@tego/server';

import { AuthMainAppController } from './actions/authMainApp';
import { AuthMainAppService } from './service/authMainAppService';

@InjectedPlugin({
  Controllers: [AuthMainAppController],
})
export class PluginAuthMainAppServer extends Plugin {
  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    // 使用 Plugin 的 this.app (构造函数直接赋值, 不受 DI Container 竞态影响)
    // 而非 @Service() + @App() 模式 (全局 DI Container 在多应用并发启动时会注入错误实例)
    const authMainAppService = new AuthMainAppService(this.app);
    await authMainAppService.load();
  }

  async install() {}

  async afterEnable() {}

  async afterDisable() {}

  async remove() {}
}

export default PluginAuthMainAppServer;

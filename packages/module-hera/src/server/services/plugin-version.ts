import { App, Application, PluginManager, Service } from '@tego/server';

@Service()
export class PluginVersionService {
  @App()
  app: Application;

  async get() {
    const pm = this.app.pm as PluginManager;
    const plugin = pm.get('@tachybase/module-hera') ?? pm.get('hera');
    return plugin.toJSON();
  }
}

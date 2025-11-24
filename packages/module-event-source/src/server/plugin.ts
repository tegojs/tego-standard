import { Application, InjectedPlugin, Plugin, PluginOptions } from '@tego/server';

import { CustomEventSourceController } from './actions/CustomEventSourceController';
import customEventSourcesCollection from './collections/customEventSources';
import { PluginWebhook } from './webhooks/Plugin';

@InjectedPlugin({
  Controllers: [CustomEventSourceController],
})
export class ModuleEventSourceServer extends Plugin {
  constructor(app: Application, options?: PluginOptions) {
    super(app, options);
    this.addFeature(PluginWebhook);
  }

  async load() {
    // 给customEventSources添加权限
    this.app.acl.registerSnippet({
      name: 'pm.business-components.custom-event-source',
      actions: ['customEventSources:*'],
    });
  }
}

export default ModuleEventSourceServer;

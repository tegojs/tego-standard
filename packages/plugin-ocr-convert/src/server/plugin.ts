import path from 'node:path';

import { Plugin, Registry } from '@tego/server';

import { initActions } from './actions';
import { initProviders } from './providers';
import { Provider } from './providers/Provider';

export class PluginOcrConvert extends Plugin {
  providers: Registry<typeof Provider> = new Registry();

  async install() {}

  async load() {
    // 初始化提供商
    await initProviders(this);
    await initActions(this.app);
    this.app.acl.registerSnippet({
      name: `pm.ocr.providers`,
      actions: ['ocr_providers:*'],
    });
  }

  async getDefault() {
    const providerRepo = this.db.getRepository('ocr_providers');
    return providerRepo.findOne({
      filter: {
        default: true,
      },
    });
  }
}

export default PluginOcrConvert;

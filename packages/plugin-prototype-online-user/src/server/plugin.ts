import { isMainThread } from 'node:worker_threads';

import { Container, Plugin } from '@tego/server';

import { ConnectionManager } from './services/connection-manager';

export class PluginOnlineUserServer extends Plugin {
  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    if (!isMainThread) {
      return;
    }
    await Container.get(ConnectionManager).load();
  }

  async install() {}

  async afterEnable() {}

  async afterDisable() {}

  async remove() {}
}

export default PluginOnlineUserServer;

import { resolve } from 'node:path';
import { InstallOptions, Logger, LoggerOptions, Plugin } from '@tego/server';

import { listByCurrentRole } from './actions/listByCurrentRole';
import { send } from './actions/send';

export class CustomRequestPlugin extends Plugin {
  logger: Logger;

  afterAdd() {}

  beforeLoad() {
    this.logger = this.getLogger();
  }

  getLogger(): Logger {
    const logger = this.createLogger({
      dirname: 'action-custom-request',
      filename: '%DATE%.log',
      transports: ctx.tego.environment.getVariables().APP_ENV === 'production' ? ['dailyRotateFile'] : ['console'],
    } as LoggerOptions);

    return logger;
  }

  async load() {
    await this.importCollections(resolve(__dirname, 'collections'));

    this.app.resourcer.define({
      name: 'customRequests',
      actions: {
        send: send.bind(this),
        listByCurrentRole,
      },
    });

    this.app.acl.registerSnippet({
      name: `ui.${this.name}`,
      actions: ['customRequests:*', 'roles:list'],
    });

    this.app.acl.allow('customRequests', ['send', 'listByCurrentRole'], 'loggedIn');
  }

  async install(options?: InstallOptions) {}

  async afterEnable() {}

  async afterDisable() {}

  async remove() {}
}

export default CustomRequestPlugin;

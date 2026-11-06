import { resolve } from 'node:path';
import { InstallOptions, Logger, LoggerOptions, Plugin, type PluginOptions } from '@tego/server';

import { listByCurrentRole } from './actions/listByCurrentRole';
import { send } from './actions/send';
import { captureCurrentRecordReadGuard, type CustomRequestCurrentRecordReadGuard } from './current-record-read-guard';

export interface CustomRequestPluginOptions extends PluginOptions {
  /** Server bootstrap only; veto unadapted reads before business or outbound I/O. */
  currentRecordReadGuard?: CustomRequestCurrentRecordReadGuard;
}

export class CustomRequestPlugin extends Plugin {
  declare options: CustomRequestPluginOptions;
  logger: Logger;

  afterAdd() {}

  beforeLoad() {
    this.logger = this.getLogger();
  }

  getLogger(): Logger {
    const logger = this.createLogger({
      dirname: 'action-custom-request',
      filename: '%DATE%.log',
      transports: process.env.APP_ENV === 'production' ? ['dailyRotateFile'] : ['console'],
    } as LoggerOptions);

    return logger;
  }

  async load() {
    const currentRecordReadGuard = captureCurrentRecordReadGuard(this.options.currentRecordReadGuard);
    this.app.resourcer.define({
      name: 'customRequests',
      actions: {
        send: send.bind(this, currentRecordReadGuard),
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

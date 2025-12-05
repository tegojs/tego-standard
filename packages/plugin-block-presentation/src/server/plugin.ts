import path from 'node:path';
import { InstallOptions, Plugin } from '@tego/server';

import { getHtml } from './actions';

export class IframeBlockPlugin extends Plugin {
  afterAdd() {}

  beforeLoad() {}

  async load() {
    this.app.resourcer.registerActions({
      'iframeHtml:getHtml': getHtml,
    });

    this.app.acl.allow('iframeHtml', 'getHtml', 'loggedIn');
    this.app.acl.registerSnippet({
      name: 'ui.iframeHtml',
      actions: ['iframeHtml:*'],
    });
  }

  async install(options?: InstallOptions) {}

  async afterEnable() {}

  async afterDisable() {}

  async remove() {}
}

export default IframeBlockPlugin;

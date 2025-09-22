import { Plugin } from '@tachybase/client';

import { lang } from './locale';
import { PageSpyButtonProvider } from './PageSpy';
import { PageSpyPane } from './PageSpyPane';
import { PageSpyProvider } from './PageSpyProvider';

class PluginPluginPagespy extends Plugin {
  async load() {
    this.app.use(PageSpyProvider);
    this.app.use(PageSpyButtonProvider);
    this.app.systemSettingsManager.add('system-services.pagespy', {
      icon: 'BugOutlined',
      title: lang('PageSpy config'),
      Component: PageSpyPane,
      aclSnippet: 'pm.system-services.pagespy',
    });
  }
}

export default PluginPluginPagespy;

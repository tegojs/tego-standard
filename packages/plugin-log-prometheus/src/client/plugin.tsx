import { Plugin } from '@tachybase/client';

import { lang } from './locale';
import { MetricsConfigsPane } from './MetricsConfigsPane';

class PluginLogMetricsClient extends Plugin {
  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    this.app.systemSettingsManager.add('system-services.prometheus', {
      icon: 'SlidersOutlined',
      title: lang('Metrics configurations'),
      Component: MetricsConfigsPane,
      aclSnippet: 'pm.system-services.prometheus',
    });
  }
}

export default PluginLogMetricsClient;

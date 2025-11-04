import { Plugin } from '@tachybase/client';

import { NAMESPACE } from './locale';
import { TableDetail } from './pages/TableDetail';
import { TableList } from './pages/TableList';

class PluginPluginDatabaseClean extends Plugin {
  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    // 注册列表页面
    this.app.systemSettingsManager.add('system-services.' + NAMESPACE, {
      title: this.t('Database Clean'),
      icon: 'DatabaseOutlined',
      Component: TableList,
      aclSnippet: 'pm.database-clean.*',
      sort: -50,
    });

    // 注册详情页面
    this.app.systemSettingsManager.add('system-services.' + NAMESPACE + '/:tableName', {
      title: this.t('Table Detail'),
      Component: TableDetail,
      groupKey: 'system-services.' + NAMESPACE,
      aclSnippet: 'pm.database-clean.*',
    });
  }
}

export default PluginPluginDatabaseClean;

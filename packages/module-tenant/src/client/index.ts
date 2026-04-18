import { Plugin } from '@tachybase/client';

import CurrentTenantProvider from './CurrentTenantProvider';
import { tval } from './locale';
import { TenantManagement } from './TenantManagement';
import TenantMenuProvider from './TenantMenuProvider';

class PluginTenantClient extends Plugin {
  async load() {
    this.app.use(CurrentTenantProvider);
    this.app.use(TenantMenuProvider);
    this.app.systemSettingsManager.add('id-auth.tenants', {
      title: tval('Tenants'),
      icon: 'ApartmentOutlined',
      Component: TenantManagement,
      aclSnippet: 'pm.tenant.manage',
      sort: 6,
    });
  }
}

export default PluginTenantClient;

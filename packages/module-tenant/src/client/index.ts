import { Plugin, tenantConfigurableProperties } from '@tachybase/client';

import CurrentTenantProvider from './CurrentTenantProvider';
import { LegacyDataTenantSelect } from './LegacyDataTenantSelect';
import { tval } from './locale';
import { TenantManagement } from './TenantManagement';
import TenantMenuProvider from './TenantMenuProvider';

/** Template names that support tenant-level data isolation. */
const TENANT_CAPABLE_TEMPLATES = ['general', 'expression', 'tree'];

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

    // Register tenant-specific schema components
    this.app.addComponents({ LegacyDataTenantSelect });

    // Inject tenancy fields into collection templates that support tenant isolation
    const ctm = this.app.dataSourceManager.collectionTemplateManager;
    for (const name of TENANT_CAPABLE_TEMPLATES) {
      const tpl = ctm.getCollectionTemplate(name);
      if (tpl) {
        Object.assign(tpl.configurableProperties, tenantConfigurableProperties);
      }
    }
  }
}

export default PluginTenantClient;

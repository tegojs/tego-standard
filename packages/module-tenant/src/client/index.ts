import { Plugin, tenantConfigurableProperties } from '@tachybase/client';

import CurrentTenantProvider from './CurrentTenantProvider';
import { LegacyDataTenantSelect } from './LegacyDataTenantSelect';
import { tval } from './locale';
import { TenantManagement } from './TenantManagement';
import TenantMenuProvider from './TenantMenuProvider';

/** Template names that support tenant-level data isolation. */
const TENANT_CAPABLE_TEMPLATES = ['general', 'expression', 'tree'];

const SQL_COLLECTION_TENANT_WARNING = '{{t("SQL_COLLECTION_TENANT_ISOLATION_WARNING")}}';
const VIEW_COLLECTION_TENANT_WARNING = '{{t("VIEW_COLLECTION_TENANT_ISOLATION_WARNING")}}';
const WORKFLOW_SQL_TENANT_WARNING = '{{t("SQL_NODE_TENANT_ISOLATION_WARNING", { ns: "workflow" })}}';

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

    const sqlTemplate = ctm.getCollectionTemplate('sql');
    const sqlField = (sqlTemplate?.configurableProperties as any)?.config?.properties?.sql;
    if (sqlField) {
      sqlField.description = SQL_COLLECTION_TENANT_WARNING;
    }

    const viewTemplate = ctm.getCollectionTemplate('view');
    const databaseViewField = viewTemplate?.configurableProperties?.databaseView;
    if (databaseViewField) {
      databaseViewField.description = VIEW_COLLECTION_TENANT_WARNING;
    }
  }

  async afterLoad() {
    const workflow = this.app.pm.get('workflow') as any;
    const sqlInstruction = workflow?.instructions?.get?.('sql');
    const sqlField = sqlInstruction?.fieldset?.sql;
    if (sqlField) {
      sqlField.description = WORKFLOW_SQL_TENANT_WARNING;
    }
  }
}

export default PluginTenantClient;

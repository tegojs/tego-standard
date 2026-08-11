import { Plugin } from '@tachybase/client';

import { TENANT_IMPERSONATION_SNIPPET } from '../constants';
import CurrentTenantProvider from './CurrentTenantProvider';
import { LegacyDataTenantSelect } from './LegacyDataTenantSelect';
import { tval } from './locale';
import { tenantConfigurableProperties } from './tenant-configurable-properties';
import { TenantManagement } from './TenantManagement';
import TenantMenuProvider from './TenantMenuProvider';

/** Template names that support tenant-level data isolation. */
const TENANT_CAPABLE_TEMPLATES = ['general', 'expression', 'tree'];

const SQL_COLLECTION_TENANT_WARNING_KEY =
  '⚠ Tenant isolation warning: SQL collections do not support tenant isolation. The SQL statement is executed as-is with no automatic tenantId filtering. If tenant-scoped data access is needed, manually include tenantId conditions in your SQL, or use a general collection with proper tenancy configuration.';
const VIEW_COLLECTION_TENANT_WARNING_KEY =
  '⚠ Tenant isolation warning: View collections do not support tenant isolation. Queries are executed as raw SQL with no automatic tenantId filtering. If tenant-level data isolation is required, implement row-level security policies (e.g. PostgreSQL RLS) on the underlying database view.';
const SQL_COLLECTION_TENANT_WARNING = `{{t("${SQL_COLLECTION_TENANT_WARNING_KEY}")}}`;
const VIEW_COLLECTION_TENANT_WARNING = `{{t("${VIEW_COLLECTION_TENANT_WARNING_KEY}")}}`;
const WORKFLOW_SQL_TENANT_WARNING = '{{t("SQL_NODE_TENANT_ISOLATION_WARNING", { ns: "workflow" })}}';

function ensureConfigurableProperties(template: any) {
  if (!template) {
    return null;
  }

  if (!template.configurableProperties || typeof template.configurableProperties !== 'object') {
    template.configurableProperties = {};
  }

  return template.configurableProperties;
}

function getSqlTemplateField(template: any, logger?: { warn?: (message: string) => void }) {
  const configurableProperties = template?.configurableProperties;
  const sqlField = configurableProperties?.config?.properties?.sql;

  if (sqlField && typeof sqlField === 'object') {
    return sqlField;
  }

  logger?.warn?.('Tenant plugin could not patch SQL collection template warning: expected config.properties.sql.');
  return null;
}

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
    this.app.systemSettingsManager.add('id-auth.tenants.impersonate', {
      title: tval('Tenant impersonation'),
      aclSnippet: TENANT_IMPERSONATION_SNIPPET,
      aclMode: 'explicit',
      hideInMenu: true,
      sort: 7,
    });

    // Register tenant-specific schema components
    this.app.addComponents({ LegacyDataTenantSelect });

    // Inject tenancy fields into collection templates that support tenant isolation
    const ctm = this.app.dataSourceManager.collectionTemplateManager;
    for (const name of TENANT_CAPABLE_TEMPLATES) {
      const tpl = ctm.getCollectionTemplate(name);
      const configurableProperties = ensureConfigurableProperties(tpl);
      if (configurableProperties) {
        Object.assign(configurableProperties, tenantConfigurableProperties);
      }
    }

    const sqlTemplate = ctm.getCollectionTemplate('sql');
    const sqlField = getSqlTemplateField(sqlTemplate, (this.app as any).logger);
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

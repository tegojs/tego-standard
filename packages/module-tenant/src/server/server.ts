import { Plugin } from '@tego/server';

import availableTenants from './actions/available-tenants';
import currentTenant from './actions/current-tenant';
import switchTenant from './actions/switch-tenant';
import tenantUsersCollection from './collections/tenantUsers';
import tenantsCollection from './collections/tenants';
import usersCollection from './collections/users';
import applyTenantFilter from './helpers/tenant-filter';
import isTenantScopedCollection from './helpers/isTenantScopedCollection';
import { enUS, zhCN } from './locale';
import setCurrentTenant from './middlewares/setCurrentTenant';

export interface TenantPluginConfig {
  name: string;
}

export class PluginTenantServer extends Plugin {
  async loadCollections() {
    return;
  }

  async beforeLoad() {
    this.app.i18n.addResources('zh-CN', this.name, zhCN);
    this.app.i18n.addResources('en-US', this.name, enUS);

    this.db.collection(tenantsCollection);
    this.db.collection(tenantUsersCollection);
    this.db.extendCollection(usersCollection.collectionOptions, usersCollection.mergeOptions);

    this.app.resourcer.registerActionHandler('tenants:available', availableTenants);
    this.app.resourcer.registerActionHandler('tenants:current', currentTenant);
    this.app.resourcer.registerActionHandler('tenants:switch', switchTenant);

    this.app.resourcer.use(setCurrentTenant, {
      tag: 'setCurrentTenant',
      after: 'auth',
      before: 'acl',
    });

    this.app.resourcer.use(
      async (ctx, next) => {
        const dataSourceKey =
          ctx.get('X-data-source') || ctx.get('x-data-source') || ctx.action.params?.dataSource || 'main';
        const dataSource =
          dataSourceKey && dataSourceKey !== 'main' ? ctx.tego.dataSourceManager.dataSources.get(dataSourceKey) : null;
        const db = dataSource?.collectionManager?.db || ctx.db;
        const collection = db.getCollection(ctx.action.resourceName);
        if (isTenantScopedCollection(collection)) {
          if (!ctx.state.currentTenant?.id && !ctx.state.currentTenantId) {
            ctx.throw(403, 'Tenant context is required');
          }

          applyTenantFilter(ctx);
        }

        await next();
      },
      {
        tag: 'tenantResourceGuard',
        after: 'acl',
        before: 'dataSource',
      },
    );

    this.app.acl.registerSnippet({
      name: 'pm.tenant.manage',
      actions: ['tenants:*', 'tenantUsers:*', 'users:list', 'users:update'],
    });

    this.app.acl.allow('tenants', ['available', 'current', 'switch'], 'loggedIn');
  }
}

export default PluginTenantServer;

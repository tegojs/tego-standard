import { Plugin } from '@tego/server';

import currentTenant from './actions/current-tenant';
import switchTenant from './actions/switch-tenant';
import tenantUsersCollection from './collections/tenantUsers';
import tenantsCollection from './collections/tenants';
import usersCollection from './collections/users';
import applyTenantFilter from './helpers/tenant-filter';
import isTenantScopedCollection from './helpers/isTenantScopedCollection';
import setCurrentTenant from './middlewares/setCurrentTenant';

export interface TenantPluginConfig {
  name: string;
}

export class PluginTenantServer extends Plugin {
  async loadCollections() {
    return;
  }

  async beforeLoad() {
    this.db.collection(tenantsCollection);
    this.db.collection(tenantUsersCollection);
    this.db.extendCollection(usersCollection.collectionOptions, usersCollection.mergeOptions);

    this.app.resourcer.registerActionHandler('tenants:current', currentTenant);
    this.app.resourcer.registerActionHandler('tenants:switch', switchTenant);

    this.app.resourcer.use(setCurrentTenant, {
      tag: 'setCurrentTenant',
      after: 'auth',
      before: 'acl',
    });

    this.app.resourcer.use(
      async (ctx, next) => {
        const collection = ctx.db.getCollection(ctx.action.resourceName);
        if (isTenantScopedCollection(collection)) {
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

    this.app.acl.allow('tenants', ['current', 'switch'], 'loggedIn');
  }
}

export default PluginTenantServer;

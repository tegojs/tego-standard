import { Plugin } from '@tego/server';

import { NAMESPACE } from '../constants';
import availableTenants from './actions/available-tenants';
import currentTenant from './actions/current-tenant';
import switchTenant from './actions/switch-tenant';
import tenantsCollection from './collections/tenants';
import tenantUsersCollection from './collections/tenantUsers';
import usersCollection from './collections/users';
import { ensureTenantIdField } from './helpers/ensure-tenant-id-field';
import { getCollectionTenancyMode } from './helpers/isTenantScopedCollection';
import applyTenantFilter from './helpers/tenant-filter';
import { buildPath, getDescendantIds, wouldCreateCycle } from './helpers/tenant-tree';
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
    this.app.i18n.addResources('zh-CN', NAMESPACE, zhCN);
    this.app.i18n.addResources('en-US', NAMESPACE, enUS);

    this.db.collection(tenantsCollection);
    this.db.collection(tenantUsersCollection);
    this.db.extendCollection(usersCollection.collectionOptions, usersCollection.mergeOptions);

    this.app.resourcer.registerActionHandler('tenants:available', availableTenants);
    this.app.resourcer.registerActionHandler('tenants:current', currentTenant);
    this.app.resourcer.registerActionHandler('tenants:switch', switchTenant);

    this.db.on('collections.afterCreateWithAssociations', ensureTenantIdField);
    this.db.on('collections.afterUpdateWithAssociations', ensureTenantIdField);
    this.db.on('collections.afterUpdate', ensureTenantIdField);

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
        const tenancyMode = getCollectionTenancyMode(collection);

        if (tenancyMode === 'tenantScoped' || tenancyMode === 'tenantInherited') {
          if (!ctx.state.currentTenant?.id && !ctx.state.currentTenantId) {
            ctx.throw(403, 'Tenant context is required');
          }

          ctx.state.currentTenancyMode = tenancyMode;
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

    this.db.on('tenants.beforeCreate', async (model, options) => {
      const transaction = options?.transaction;
      const parentId = model.get('parentId') || null;
      let parentPath: string | null = null;

      if (parentId) {
        const parent = await this.db.getRepository('tenants').findOne({
          filter: { id: parentId },
          transaction,
        });

        if (!parent) {
          throw new Error(`Parent tenant "${parentId}" not found`);
        }

        if (!parent.get('enabled')) {
          throw new Error(`Parent tenant "${parentId}" is disabled`);
        }

        parentPath = parent.get('path') as string;
      }

      const id = model.get('id');
      model.set('path', buildPath(parentPath, id));
    });

    this.db.on('tenants.beforeUpdate', async (model, options) => {
      const transaction = options?.transaction;
      const newParentId = model.get('parentId');

      if (newParentId === undefined) {
        return;
      }

      const tenantId = model.get('id') as string;
      const repo = this.db.getRepository('tenants');

      if (newParentId) {
        if (await wouldCreateCycle(repo, tenantId, newParentId)) {
          throw new Error('Cannot move tenant: would create a cycle');
        }

        const newParent = await repo.findOne({
          filter: { id: newParentId },
          transaction,
        });

        if (!newParent) {
          throw new Error(`Parent tenant "${newParentId}" not found`);
        }

        const tenant = await repo.findOne({
          filter: { id: tenantId },
          transaction,
        });

        if (tenant) {
          const oldPath = tenant.get('path') as string;
          const newPath = buildPath(newParent.get('path') as string, tenantId);

          // Update all descendant paths in the subtree
          const descendants = await repo.find({
            filter: { path: { $like: `${oldPath}%` } },
            transaction,
          });

          for (const desc of descendants) {
            const descPath = desc.get('path') as string;
            const updatedPath = descPath.replace(oldPath, newPath);
            await repo.update({
              filterByTk: desc.get('id'),
              values: { path: updatedPath },
              transaction,
            });
          }
        }
      }
    });

    this.db.on('tenants.beforeDestroy', async (model, options) => {
      const transaction = options?.transaction;
      const tenantId = model.get('id') as string;
      const repo = this.db.getRepository('tenants');

      const children = await repo.find({
        filter: { parentId: tenantId },
        fields: ['id'],
        transaction,
      });

      if (children.length > 0) {
        throw new Error('Cannot delete tenant with children. Remove or reassign children first.');
      }
    });
  }
}

export default PluginTenantServer;

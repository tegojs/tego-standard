import { Plugin, uid } from '@tego/server';

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
import { buildPath, getDescendantIds, getDescendantPathFilter, wouldCreateCycle } from './helpers/tenant-tree';
import { enUS, zhCN } from './locale';
import setCurrentTenant from './middlewares/setCurrentTenant';

export interface TenantPluginConfig {
  name: string;
}

export class PluginTenantServer extends Plugin {
  async ensureTenantAclScope(options: any = {}) {
    const repo = this.db.getRepository('dataSourcesRolesResourcesScopes');
    if (!repo) {
      return;
    }

    await repo.firstOrCreate({
      filterKeys: ['dataSourceKey', 'key'],
      values: {
        dataSourceKey: 'main',
        key: 'tenant',
        name: '{{t("Current tenant records")}}',
        scope: {
          tenantId: '{{ ctx.state.currentTenant.id }}',
        },
      },
      transaction: options.transaction,
    });
  }

  async loadCollections() {
    this.db.collection(tenantsCollection);
    this.db.collection(tenantUsersCollection);
    this.db.extendCollection(usersCollection.collectionOptions, usersCollection.mergeOptions);
  }

  async beforeLoad() {
    this.app.i18n.addResources('zh-CN', NAMESPACE, zhCN);
    this.app.i18n.addResources('en-US', NAMESPACE, enUS);

    // Expose the Application instance to middleware via ctx.app.__application.
    // ctx.app in Koa middleware resolves to the Koa instance (not the
    // Application).  Security event listeners registered by plugin-audit-logs
    // live on the Application's EventEmitter.  By storing a back-reference,
    // setCurrentTenant can emit on both emitters without a global forwarder.
    if ((this.app as any)._koa) {
      (this.app as any)._koa.__application = this.app;
    }

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

    this.app.use(setCurrentTenant, {
      tag: 'setCurrentTenantForDataSource',
      after: 'auth',
      before: 'dataSource',
    });

    const applyTenantResourceGuard = async (ctx, next) => {
      const dataSourceKey =
        ctx.get('X-data-source') || ctx.get('x-data-source') || ctx.action.params?.dataSource || 'main';
      const dataSource =
        dataSourceKey && dataSourceKey !== 'main' ? ctx.tego.dataSourceManager.dataSources.get(dataSourceKey) : null;
      const db = dataSource?.collectionManager?.db || ctx.db;
      const collectionName = ctx.action.resourceName?.replace(/^api\//, '');
      const collection =
        dataSource?.collectionManager?.getCollection(collectionName) ||
        (collectionName ? dataSource?.collectionManager?.getCollection(ctx.action.resourceName) : null) ||
        db.getCollection(collectionName);
      const tenancyMode = getCollectionTenancyMode(collection);

      if (tenancyMode === 'tenantScoped' || tenancyMode === 'tenantInherited') {
        if (!ctx.state.currentTenant?.id && !ctx.state.currentTenantId) {
          await setCurrentTenant(ctx, async () => undefined);
        }

        if (!ctx.state.currentTenant?.id && !ctx.state.currentTenantId) {
          const app = (ctx.app as any).__application;
          const emitter = app && typeof app.emit === 'function' ? app : ctx.app;
          emitter.emit('tenant.securityViolation', {
            type: 'tenant_access_denied',
            userId: ctx.state.currentUser?.id,
            collectionName,
            action: ctx.action?.actionName,
            details: { tenancyMode },
          });
          ctx.throw(403, 'Tenant context is required');
        }

        ctx.state.currentTenancyMode = tenancyMode;
        ctx.state.currentLegacyDataTenantIds = collection.options?.legacyDataTenantIds || [];
        applyTenantFilter(ctx);
      }

      await next();
    };

    this.app.resourcer.use(
      async (ctx, next) => {
        const dataSourceKey =
          ctx.get('X-data-source') || ctx.get('x-data-source') || ctx.action.params?.dataSource || 'main';
        if (dataSourceKey && dataSourceKey !== 'main') {
          await next();
          return;
        }

        await applyTenantResourceGuard(ctx, next);
      },
      {
        tag: 'tenantResourceGuard',
        after: 'acl',
        before: 'dataSource',
      },
    );

    this.app.dataSourceManager.use(
      async (ctx, next) => {
        await this.app.authManager.middleware()(ctx, async () => undefined);

        if (!ctx.state.currentUser && !ctx.auth?.user && ctx.getBearerToken?.() && ctx.auth?.check) {
          ctx.auth.user = await ctx.auth.check();
        }

        await setCurrentTenant(ctx, async () => undefined);
        await applyTenantResourceGuard(ctx, next);
      },
      {
        tag: 'tenantResourceGuard',
        after: 'acl',
      },
    );

    this.app.acl.registerSnippet({
      name: 'pm.tenant.manage',
      actions: ['tenants:*', 'tenantUsers:*', 'users:list', 'users:update'],
    });

    this.app.acl.addFixedParams('rolesResourcesScopes', 'destroy', () => {
      return {
        filter: {
          'key.$ne': 'tenant',
        },
      };
    });

    this.app.acl.addFixedParams('rolesResourcesScopes', 'update', () => {
      return {
        filter: {
          'key.$ne': 'tenant',
        },
      };
    });

    this.app.acl.allow('tenants', ['available', 'current', 'switch'], 'loggedIn');

    this.db.on('tenants.beforeCreate', async (model, options) => {
      const transaction = options?.transaction;
      const parentId = model.get('parentId') || null;
      model.set('parentId', parentId);
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

      // Ensure id is available for path computation.
      // The UidField beforeCreate listener may not have fired yet depending
      // on hook registration order, so eagerly generate the id when missing.
      let id = model.get('id');
      if (!id) {
        id = uid();
        model.set('id', id);
      }
      model.set('path', buildPath(parentPath, id));
    });

    this.db.on('tenants.beforeUpdate', async (model, options) => {
      const transaction = options?.transaction;
      const rawParentId = model.get('parentId');

      if (rawParentId === undefined) {
        return;
      }

      const newParentId = rawParentId || null;
      const tenantId = model.get('id') as string;
      const repo = this.db.getRepository('tenants');
      let parentPath: string | null = null;

      model.set('parentId', newParentId);

      if (newParentId) {
        if (await wouldCreateCycle(repo, tenantId, newParentId, { transaction })) {
          throw new Error('Cannot move tenant: would create a cycle');
        }

        const newParent = await repo.findOne({
          filter: { id: newParentId },
          transaction,
        });

        if (!newParent) {
          throw new Error(`Parent tenant "${newParentId}" not found`);
        }

        if (!newParent.get('enabled')) {
          throw new Error(`Parent tenant "${newParentId}" is disabled`);
        }

        parentPath = newParent.get('path') as string;
      }

      const tenant = await repo.findOne({
        filter: { id: tenantId },
        transaction,
      });

      if (tenant) {
        const oldPath = tenant.get('path') as string;
        const newPath = buildPath(parentPath, tenantId);

        const descendants = await repo.find({
          filter: getDescendantPathFilter(oldPath, tenantId),
          transaction,
        });

        model.set('path', newPath);
        for (const desc of descendants) {
          const descPath = desc.get('path') as string;
          const updatedPath = descPath.replace(oldPath, newPath);
          desc.set('path', updatedPath);
          await desc.save({
            hooks: false,
            transaction,
          });
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

      const defaultTenantUsers = await this.db.getRepository('users').count({
        filter: { defaultTenantId: tenantId },
        transaction,
      });

      if (defaultTenantUsers > 0) {
        throw new Error('Cannot delete tenant used as a user default tenant. Clear or reassign user defaults first.');
      }
    });
  }

  async install(options) {
    await this.ensureTenantAclScope(options);
  }

  async afterEnable() {
    await this.ensureTenantAclScope();
  }
}

export default PluginTenantServer;

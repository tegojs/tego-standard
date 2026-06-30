import { createMockServer, MockServer } from '@tachybase/test';
import { AppSupervisor, Plugin } from '@tego/server';

import PluginTenantServer from '..';

async function cleanupPreviousApp(): Promise<void> {
  try {
    const supervisor = AppSupervisor.getInstance();
    const existing = await supervisor.getApp('main', { withOutBootStrap: true } as any);
    if (existing) {
      await existing.destroy({ logging: false }).catch(() => {});
    }
  } catch {
    /* no previous app — that's fine */
  }
}

const actionHandlersByPluginName = new Map<string, string[]>([
  ['ExportPlugin', ['export']],
  ['ImportPlugin', ['downloadXlsxTemplate', 'importXlsx']],
]);

async function loadPluginHooks(plugin: any, forceLoad = false) {
  if (!plugin?.enabled) {
    return;
  }

  if (!plugin.state?.loaded) {
    if (plugin.beforeLoad) await plugin.beforeLoad();
    if (plugin.loadCollections) await plugin.loadCollections();
    if (plugin.load) await plugin.load();
    plugin.state.loaded = true;
    return;
  }

  if (forceLoad && plugin.load) {
    await plugin.load();
  }
}

function findPluginInstance(app: MockServer, PluginClass: any, options: any) {
  const pm = (app as any).pm;
  const plugins = Array.from(pm.getPlugins().values()) as any[];
  return plugins.find((plugin) => {
    return (
      plugin instanceof PluginClass ||
      plugin.constructor === PluginClass ||
      plugin.constructor?.name === PluginClass?.name ||
      (options?.name && (plugin.name === options.name || plugin.options?.name === options.name))
    );
  });
}

async function ensureExtraActionPluginsLoaded(app: MockServer, extraPlugins: any[]) {
  for (const item of extraPlugins) {
    const [PluginClass, options = {}] = Array.isArray(item) ? item : [item, {}];
    const expectedHandlers = actionHandlersByPluginName.get(PluginClass?.name);
    if (!expectedHandlers) {
      continue;
    }

    const hasMissingHandler = expectedHandlers.some((handler) => !app.resourcer.getRegisteredHandler(handler));
    if (!hasMissingHandler) {
      continue;
    }

    const plugin = findPluginInstance(app, PluginClass, options);
    if (!plugin) {
      throw new Error(`Expected test plugin "${options.name || PluginClass?.name}" was not registered`);
    }

    await loadPluginHooks(plugin, true);

    const missingHandlers = expectedHandlers.filter((handler) => !app.resourcer.getRegisteredHandler(handler));
    if (missingHandlers.length > 0) {
      throw new Error(
        `Test plugin "${options.name || PluginClass?.name}" did not register action handlers: ${missingHandlers.join(
          ', ',
        )}`,
      );
    }
  }
}

export async function createTenantApp(options: { extraPlugins?: any[] } = {}): Promise<MockServer> {
  const { extraPlugins = [] } = options;

  await cleanupPreviousApp();

  class TestAuthStatusPlugin extends Plugin {
    async load() {
      if (!this.app.authManager.userStatusService) {
        this.app.authManager.setUserStatusService({
          async checkUserStatus() {
            return { allowed: true, status: 'active', isExpired: false };
          },
        });
      }
    }

    async install() {
      const rolesRepository = this.app.db.getRepository('roles');
      for (const role of [
        { name: 'admin', title: 'Admin' },
        { name: 'root', title: 'Root' },
      ]) {
        const values = {
          ...role,
          strategy: {
            actions: ['create', 'view', 'update', 'destroy', 'list', 'get', 'count', 'importXlsx'],
          },
        };
        const existing = await rolesRepository.findOne({ filterByTk: role.name });
        if (existing) {
          await rolesRepository.update({ filterByTk: role.name, values });
        } else {
          await rolesRepository.create({ values });
        }
      }
    }
  }

  let app: MockServer;
  try {
    app = await createMockServer({
      registerActions: true,
      acl: true,
      database: { dialect: 'sqlite' },
      plugins: [
        'acl',
        'error-handler',
        'users',
        'ui-schema-storage',
        'collection-manager',
        'auth',
        'data-source-manager',
        'audit-logs',
        [PluginTenantServer, { name: 'tenant', packageName: '@tachybase/module-tenant', workspaceSource: true }],
        ...extraPlugins,
        TestAuthStatusPlugin,
      ],
    });
  } catch (err) {
    await cleanupPreviousApp();
    throw err;
  }

  // Defensive: if the framework's install flow silently failed (CI-specific),
  // the tenants table won't exist.  Recover by:
  //   1. Creating missing tables via queryInterface.createTable (raw DDL,
  //      no afterDefine/afterSync hooks, no FK ordering issues)
  //   2. Running load hooks for any unloaded plugins (ExportPlugin.load
  //      registers the 'export' action handler)
  const check = await app.db.sequelize.query("SELECT name FROM sqlite_master WHERE type='table' AND name='tenants'");
  if ((check[0] as any[]).length === 0) {
    const qi = app.db.sequelize.getQueryInterface();
    for (const model of Object.values(app.db.sequelize.models) as any[]) {
      try {
        await qi.createTable(model.tableName, model.rawAttributes, {});
      } catch {
        /* already exists or dep issue */
      }
    }
    // Run load hooks for unloaded plugins so action handlers are registered
    const pm = (app as any).pm;
    for (const [, plugin] of pm.getPlugins()) {
      if (!plugin.state.loaded && plugin.enabled) {
        try {
          await loadPluginHooks(plugin);
        } catch {
          /* ignore individual plugin load failures */
        }
      }
    }
  }
  await ensureExtraActionPluginsLoaded(app, extraPlugins);
  return app;
}

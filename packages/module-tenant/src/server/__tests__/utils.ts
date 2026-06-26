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
    // Skip the framework's install and start — we control the DB lifecycle.
    //
    // The framework's sequelize.sync() fails in CI because:
    //   1. FK ordering: tenant plugin's ensureTenantIdField injects FK refs
    //      → unfavorable topo sort → FK error aborts the sync loop
    //   2. afterSync hooks: sort-field's initRecordsSortValue queries
    //      collectionCategories that doesn't exist yet → throws
    //   3. model.sync({ hooks: false }) still fails because tachybase's
    //      database.on("afterDefine") bridge triggers sort-field during
    //      queryInterface.createTable → define() internally
    //
    // Solution: call queryInterface.createTable() directly for each model,
    // using the model's rawAttributes for correct column types. This
    // generates proper DDL without triggering define() / afterDefine /
    // afterSync hooks.
    app = await createMockServer({
      registerActions: true,
      acl: true,
      database: { dialect: 'sqlite' },
      skipInstall: true,
      skipStart: true,
      plugins: [
        'acl',
        'error-handler',
        'users',
        'ui-schema-storage',
        'collection-manager',
        'auth',
        'data-source-manager',
        [PluginTenantServer, { name: 'tenant', packageName: '@tachybase/module-tenant', workspaceSource: true }],
        ...extraPlugins,
        TestAuthStatusPlugin,
      ],
    });

    // Ensure a clean slate
    await app.db.clean({ drop: true });

    // Load all plugins → registers collections and their Sequelize models
    await app.load({ hooks: false });

    // Create all tables via queryInterface.createTable() — correct DDL
    // generation without triggering afterDefine / afterSync hooks.
    const qi = app.db.sequelize.getQueryInterface();
    for (const model of Object.values(app.db.sequelize.models) as any[]) {
      try {
        await qi.createTable(model.tableName, model.rawAttributes, {
          // CREATE TABLE IF NOT EXISTS — safe to call repeatedly
        });
      } catch {
        /* table may already exist */
      }
    }

    // Run the standard pm.install() flow — handles plugin state, events,
    // and repository updates.  Patch loadCommands to no-op so it doesn't
    // try to resolve plugin packages from dist/ (not available in CI).
    const origLoadCommands = (app.pm as any).loadCommands.bind(app.pm);
    (app.pm as any).loadCommands = async () => {};
    await app.pm.install();
    (app.pm as any).loadCommands = origLoadCommands;
    await app.version.update();
    await app.runCommandThrowError('start');
  } catch (err) {
    await cleanupPreviousApp();
    throw err;
  }
  return app;
}

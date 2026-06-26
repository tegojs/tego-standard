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

/**
 * Replace db.sync with a safe implementation that uses
 * queryInterface.createTable() for each registered model.
 *
 * This bypasses sequelize.sync()'s two failure modes in CI:
 *   1. FK topo-sort abort: tenant plugin's ensureTenantIdField injects
 *      FK refs → unfavorable order → FK error kills the sync loop
 *   2. afterSync crash: sort-field's initRecordsSortValue queries
 *      collectionCategories that doesn't exist yet → throws
 *
 * queryInterface.createTable() generates correct DDL from rawAttributes
 * without triggering define() / afterDefine / afterSync hooks.
 */
let syncCallLog: string[] = [];

function patchDbSyncWithCreateTable(app: MockServer): void {
  const db = app.db as any;
  syncCallLog = [];
  db.sync = async function safeCreateTableSync() {
    const modelCount = Object.keys(db.sequelize.models).length;
    const qi = db.sequelize.getQueryInterface();
    let created = 0;
    for (const model of Object.values(db.sequelize.models) as any[]) {
      try {
        await qi.createTable(model.tableName, model.rawAttributes, {});
        created++;
      } catch {
        /* table may already exist or dep issue */
      }
    }
    syncCallLog.push(`sync#${syncCallLog.length + 1}: ${modelCount}models/${created}tables`);
  };
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
      beforeInstall: (a: MockServer) => {
        // Patch db.sync BEFORE the install flow runs. The install command
        // calls db.sync() twice: once in Application.install() (before
        // collections are registered — harmless) and once in pm.install()
        // (after collections — this is where the original fails).
        patchDbSyncWithCreateTable(a);
      },
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
  } catch (err) {
    await cleanupPreviousApp();
    throw err;
  }

  // Verify tenants table exists — throw diagnostic if not
  const check = await app.db.sequelize.query(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  );
  const tableNames = (check[0] as any[]).map((r: any) => r.name);
  if (!tableNames.includes('tenants')) {
    throw new Error(
      `[createTenantApp] tenants missing. syncLog: [${syncCallLog.join('; ')}]. ` +
        `Tables(${tableNames.length}): ${tableNames.join(',')}. ` +
        `Models(${Object.keys((app.db.sequelize as any).models || {}).length}). ` +
        `Collections(${app.db.collections.size}). ` +
        `Storage: ${(app.db as any).options?.storage}`,
    );
  }
  return app;
}

import { createMockServer, MockServer } from '@tachybase/test';
import { AppSupervisor, Plugin } from '@tego/server';

import PluginTenantServer from '..';

// Monkey-patch loadCollections to add CI diagnostics
const _origLoadCollections = PluginTenantServer.prototype.loadCollections;
PluginTenantServer.prototype.loadCollections = async function patchedLoadCollections(this: any) {
  // eslint-disable-next-line no-console
  console.log('[DIAG] PluginTenantServer.loadCollections called, db.collections before:', Array.from(this.db.collections.keys()));
  const result = await _origLoadCollections.call(this);
  // eslint-disable-next-line no-console
  console.log('[DIAG] PluginTenantServer.loadCollections done, db.collections after:', Array.from(this.db.collections.keys()));
  return result;
};

/**
 * Remove any leftover app from a previous failed test.
 * When createMockServer throws mid-flight the app may already be
 * registered in AppSupervisor (the constructor calls addApp before
 * install/start).  The next test would then hit
 * "app main already exists".  This helper prevents that cascade.
 */
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

  // Guarantee no stale "main" app from a previous failed test
  await cleanupPreviousApp();

  class TestAuthStatusPlugin extends Plugin {
    async load() {
      if (!this.app.authManager.userStatusService) {
        this.app.authManager.setUserStatusService({
          async checkUserStatus() {
            return {
              allowed: true,
              status: 'active',
              isExpired: false,
            };
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

  // SyncPlugin runs inside pm.install() after all other plugins have
  // registered their collections.  This is the only reliable place to
  // create application tables because pm.install() own db.sync() runs
  // BEFORE loadCollections().
  //
  // We also force in-memory SQLite (no storage file) so that
  // isInstalled() always returns false on a fresh createMockServer
  // call — preventing pm.install from being skipped when a previous
  // test left a stale database file (CI uses file-based SQLite via
  // setupServerTestEnvironment).
  class SyncPlugin extends Plugin {
    async install() {
      const diag = {
        storage: (this.db as any).options?.storage,
        dialect: (this.db as any).options?.dialect,
        isMemory: (this.db as any).sequelize?.options?.storage,
        modelNames: [] as string[],
        tenantModel: false,
        syncedTables: [] as string[],
      };
      try {
        await this.db.sequelize.query('PRAGMA foreign_keys = OFF');
        const models = Object.values(this.db.sequelize.models);
        diag.modelNames = models.map((m: any) => m.tableName || m.name);
        diag.tenantModel = models.some((m: any) => (m.tableName || m.name) === 'tenants');
        // First pass — create what we can
        for (const m of models) {
          try {
            await m.sync();
            diag.syncedTables.push((m as any).tableName || (m as any).name);
          } catch {
            /* FK dep or other */
          }
        }
        // Second pass — retry models whose FK deps now exist
        for (const m of models) {
          try {
            await m.sync();
          } catch {
            /* still fails */
          }
        }
        // Final fallback: full db.sync() to catch any collections
        // that registered models after the per-model loop above.
        try {
          await this.db.sync();
        } catch {
          /* already synced */
        }
        await this.db.sequelize.query('PRAGMA foreign_keys = ON');
      } catch {
        /* pragma unsupported — ignore */
      }
      // eslint-disable-next-line no-console
      console.log('[SyncPlugin DIAG]', JSON.stringify(diag));
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
        [PluginTenantServer, { name: 'tenant', packageName: '@tachybase/module-tenant', workspaceSource: true }],
        ...extraPlugins,
        TestAuthStatusPlugin,
        SyncPlugin,
      ],
    });
  } catch (err) {
    // createMockServer may have partially constructed the app and
    // registered it in AppSupervisor before failing.  Clean up so
    // the next test doesn't hit "app main already exists".
    await cleanupPreviousApp();
    throw err;
  }
  // Post-create diagnostics
  try {
    const dbOpts = (app.db as any).options || {};
    const tables = await app.db.sequelize.query(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const collNames = Array.from(app.db.collections.keys());
    const modelNames = Object.keys((app.db.sequelize as any).models || {});
    // eslint-disable-next-line no-console
    console.log(
      '[createTenantApp DIAG]',
      JSON.stringify({
        storage: dbOpts.storage,
        collections: collNames,
        models: modelNames,
        tables: (tables[0] as any[]).map((r: any) => r.name),
        hasTenantsColl: collNames.includes('tenants'),
        hasTenantsModel: modelNames.includes('tenants'),
        hasTenantsTable: (tables[0] as any[]).some((r: any) => r.name === 'tenants'),
      }),
    );
  } catch (diagErr) {
    // eslint-disable-next-line no-console
    console.log('[createTenantApp DIAG] error:', (diagErr as Error).message);
  }
  return app;
}

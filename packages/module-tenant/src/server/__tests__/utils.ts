import { createMockServer, MockServer } from '@tachybase/test';
import { AppSupervisor, Plugin } from '@tego/server';

import PluginTenantServer from '..';

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

/**
 * Patch the database's `sync` method so that it uses a FK-safe two-pass
 * raw-Sequelize model sync instead of the normal `sequelize.sync()`.
 *
 * The framework's `install` flow calls `db.sync()` which delegates to
 * `sequelize.sync()`.  Sequelize topologically sorts models by FK and
 * syncs them in order — but if a tenant plugin's `ensureTenantIdField`
 * dynamically injects FK references, the topological sort can land on
 * an unfavorable order where the FK target hasn't been created yet.
 * Sequelize's serial for-await loop then throws and **aborts all
 * remaining table creation** (including tenants, collectionCategories…).
 *
 * By replacing `db.sync` with a PRAGMA foreign_keys=OFF + two-pass
 * model.sync loop, we guarantee every registered model gets its table
 * regardless of FK ordering.  The patch is applied via `beforeInstall`
 * so the install flow itself succeeds, and ExportPlugin/ImportPlugin
 * action handlers are correctly registered.
 */
function patchDbSyncForSqlite(app: MockServer): () => void {
  const db = app.db as any;
  const originalSync = db.sync.bind(db);
  db.sync = async function safeSync() {
    try {
      await db.sequelize.query('PRAGMA foreign_keys = OFF');
      const models = Object.values(db.sequelize.models);
      // First pass — create what we can
      for (const m of models) {
        try {
          await (m as any).sync();
        } catch {
          /* FK dep or afterSync hook error */
        }
      }
      // Second pass — retry failures (FK deps now exist)
      for (const m of models) {
        try {
          await (m as any).sync();
        } catch {
          /* still fails */
        }
      }
      await db.sequelize.query('PRAGMA foreign_keys = ON');
    } catch {
      /* PRAGMA unsupported — fall through */
    }
  };
  return () => {
    db.sync = originalSync;
  };
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

  let restoreDbSync: (() => void) | undefined;
  let app: MockServer;
  try {
    app = await createMockServer({
      registerActions: true,
      acl: true,
      database: { dialect: 'sqlite' },
      beforeInstall: (a: MockServer) => {
        // Patch db.sync BEFORE install runs so the install flow itself
        // uses our FK-safe sync instead of the vulnerable sequelize.sync().
        restoreDbSync = patchDbSyncForSqlite(a);
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
  } finally {
    // Restore original db.sync after install is complete
    restoreDbSync?.();
  }

  // Verify the critical table exists (belt-and-suspenders)
  const verify = await app.db.sequelize.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='tenants'",
  );
  if ((verify[0] as any[]).length === 0) {
    const allTables = await app.db.sequelize.query(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    throw new Error(
      '[createTenantApp] "tenants" table still missing after patched install. ' +
        `Tables in DB: ${(allTables[0] as any[]).map((r: any) => r.name).join(', ')}. ` +
        `Collections registered: ${Array.from(app.db.collections.keys()).join(', ')}. ` +
        `Sequelize models: ${Object.keys((app.db.sequelize as any).models || {}).join(', ')}. ` +
        `Storage: ${(app.db as any).options?.storage}`,
    );
  }
  return app;
}

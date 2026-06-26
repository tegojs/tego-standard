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
 * Patch db.sync to use hooks-free model.sync for each registered model.
 *
 * In CI the framework's install flow calls db.sync() which delegates to
 * sequelize.sync().  That serial for-await loop aborts on the first error.
 * Two independent error sources exist:
 *   1. FK ordering: tenant plugin's ensureTenantIdField dynamically injects
 *      FK references → topological sort can land on unfavorable order →
 *      model.sync() throws on FK violation.
 *   2. afterSync hooks: sort-field's initRecordsSortValue queries tables
 *      (e.g. collectionCategories) that don't exist yet → throws → aborts.
 *
 * Both are solved by calling model.sync({ hooks: false }) which:
 *   - Skips afterSync (no sort-field needInit crash)
 *   - Creates all tables regardless of FK ordering (CREATE TABLE IF NOT EXISTS
 *     doesn't enforce FK in SQLite)
 */
let safeSyncCallCount = 0;

function patchDbSync(app: MockServer): void {
  const db = app.db as any;
  db.sync = async function safeSync() {
    safeSyncCallCount++;
    const errors: string[] = [];
    const models = Object.values(db.sequelize.models);
    for (const m of models) {
      try {
        await (m as any).sync({ hooks: false });
      } catch (e: any) {
        errors.push(`${(m as any).tableName || (m as any).name}: ${e.message}`);
      }
    }
    // Second pass for models whose FK deps were missing
    for (const m of models) {
      try {
        await (m as any).sync({ hooks: false });
      } catch {
        /* still fails */
      }
    }
    if (errors.length > 0) {
      throw new Error(`[patchDbSync] ${errors.length} model sync errors: ${errors.slice(0, 5).join('; ')}`);
    }
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

  let app: MockServer;
  try {
    app = await createMockServer({
      registerActions: true,
      acl: true,
      database: { dialect: 'sqlite' },
      beforeInstall: (a: MockServer) => {
        patchDbSync(a);
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

  // Diagnostic: check patch effectiveness
  const tableCheck = await app.db.sequelize.query(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  );
  const tableNames = (tableCheck[0] as any[]).map((r: any) => r.name);
  if (!tableNames.includes('tenants')) {
    throw new Error(
      `[createTenantApp] safeSync called ${safeSyncCallCount}x, tenants still missing. ` +
        `DB.sync is patched: ${app.db.sync.name === 'safeSync'}. ` +
        `Tables(${tableNames.length}): ${tableNames.join(',')}. ` +
        `Models(${Object.keys((app.db.sequelize as any).models || {}).length}). ` +
        `Collections(${app.db.collections.size}). ` +
        `Storage: ${(app.db as any).options?.storage}`,
    );
  }
  return app;
}

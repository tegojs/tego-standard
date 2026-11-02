import { ACL, Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { grantStoredScope, seedAclScopes } from './acl-database';
import { withAmbientTransactions } from './ambient-transactions';
import { configStore, initialConfig, mainIdentity, registerConfigModels, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, queryRows } from './database';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

describe.skipIf(!postgresUrl)('built-in scope delegation reads committed primary authority', () => {
  let primary: Database;
  let routed: Database;
  let acl: ACL;
  let adapter: AccessAclScopeAdapter;
  const filter = { tenantId: '{{ ctx.state.currentTenant.id }}' };

  beforeEach(async () => {
    primary = isolatedPostgresDatabase(postgresUrl!);
    await seedConfigStore(primary);
    await seedAclScopes(primary);
    acl = new ACL();
    await grantStoredScope(primary, acl);
    await primary.sequelize.query('CREATE SCHEMA acl_ambient_stale');
    await primary.sequelize.query(
      'CREATE TABLE acl_ambient_stale."dataSourcesRolesResourcesScopes" (LIKE public."dataSourcesRolesResourcesScopes" INCLUDING ALL)',
    );
    await primary.sequelize.query(
      'INSERT INTO acl_ambient_stale."dataSourcesRolesResourcesScopes" SELECT * FROM public."dataSourcesRolesResourcesScopes"',
    );
    const { host, port, database, username, password } = primary.options;
    const connection = { host, port, database, username, password };
    routed = new Database({
      ...primary.options,
      replication: {
        write: connection,
        read: [{ ...connection, dialectOptions: { application_name: 'acl-ambient-reader' } }],
      },
    });
    routed.sequelize.addHook('afterConnect', async (connection, config) => {
      if (config.dialectOptions?.application_name === 'acl-ambient-reader')
        await connection.query('SET search_path TO acl_ambient_stale');
    });
    registerConfigModels(routed);
    await seedAclScopes(routed);
    const store = configStore(routed);
    await store.save(mainIdentity, initialConfig(), { userId: 28 });
    adapter = new AccessAclScopeAdapter(acl, 'main', store, routed);
  });

  afterEach(async () => {
    if (routed) await routed.close();
    if (primary) {
      try {
        await primary.sequelize.query('DROP SCHEMA IF EXISTS acl_ambient_stale CASCADE');
        await primary.sequelize.query(
          'DROP TABLE IF EXISTS "rolesResourcesScopesActions", "dataSourcesRolesResourcesScopesActions", "rolesResourcesScopes", "dataSourcesRolesResourcesScopes", "access_config_collections", "access_config_dataSourcesCollections", "tenantAccessRevisions" CASCADE',
        );
      } finally {
        await primary.close();
      }
    }
  });

  function resolve(ctx: object) {
    return adapter.resolve(
      { acl, role: 'member', resource: 'documents', action: 'list', source: 'resource', ctx },
      acl.getRole('member').getActionParams('documents:list'),
    );
  }

  async function inOldReader(work: () => Promise<void>) {
    await withAmbientTransactions(routed, async () => {
      await routed.sequelize.transaction({ readOnly: true }, async (transaction) => {
        expect(await queryRows(routed, 'SELECT current_schema() AS schema', { transaction })).toEqual([
          { schema: 'acl_ambient_stale' },
        ]);
        await work();
        expect(transaction.finished).toBeFalsy();
      });
    });
  }

  it.each(['removed', 'replaced', 'modified', 'ambiguous'])(
    'retains role restrictions after authority is %s',
    async (change) => {
      const scopes = primary.getCollection('dataSourcesRolesResourcesScopes').model;
      if (change === 'removed' || change === 'replaced') await scopes.destroy({ where: {} });
      if (change === 'replaced' || change === 'ambiguous')
        await scopes.create({ key: 'tenant', dataSourceKey: 'main', scope: filter });
      if (change === 'modified')
        await scopes.update({ scope: { ...filter, active: true } }, { where: { key: 'tenant' } });
      await inOldReader(async () => {
        const ctx = {};
        try {
          await adapter.prepare(ctx, [mainIdentity]);
          expect(resolve(ctx)).toEqual({ filter, fields: ['id', 'name'], own: false });
        } finally {
          adapter.release(ctx);
        }
      });
    },
  );

  it('reports a retained scope in administrator inspection when primary authority changed', async () => {
    await primary.getCollection('dataSourcesRolesResourcesScopes').model.destroy({ where: {} });
    await inOldReader(async () => {
      expect(await adapter.previewRoleScope('member', 'documents', 'list')).toMatchObject({
        treatment: 'retain-role-scope',
        params: { filter, fields: ['id', 'name'], own: false },
      });
    });
  });

  it('still delegates the unchanged authoritative built-in scope', async () => {
    await inOldReader(async () => {
      const ctx = {};
      try {
        await adapter.prepare(ctx, [mainIdentity]);
        expect(resolve(ctx)).toEqual({ fields: ['id', 'name'], own: false });
        expect(await adapter.previewRoleScope('member', 'documents', 'list')).toMatchObject({
          treatment: 'delegate-builtin-scope',
        });
      } finally {
        adapter.release(ctx);
      }
    });
  });

  it('does not treat caller uncommitted scope replacement as committed authority', async () => {
    await withAmbientTransactions(routed, async () => {
      await routed.sequelize.transaction(async (transaction) => {
        await routed
          .getCollection('dataSourcesRolesResourcesScopes')
          .model.update({ scope: { ...filter, active: true } }, { where: { key: 'tenant' }, transaction });
        const ctx = {};
        try {
          await adapter.prepare(ctx, [mainIdentity]);
          expect(resolve(ctx)).toEqual({ fields: ['id', 'name'], own: false });
          expect(transaction.finished).toBeFalsy();
        } finally {
          adapter.release(ctx);
        }
      });
    });
  });
});

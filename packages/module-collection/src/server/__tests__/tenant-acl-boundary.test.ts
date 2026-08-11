/**
 * ACL permission boundary tests for SQL collections and DB Views.
 *
 * Verifies that:
 * - Member role (regular tenant user) gets 403 on data-execution actions
 *   (sqlCollection:execute, dbViews:query)
 * - Member role gets 403 on configuration actions (sqlCollection:setFields, sqlCollection:update)
 * - Metadata actions (dbViews:list, dbViews:get) follow the standard strategy
 * - Admin role can access these resources via the pm.database-connections.collections snippet
 * - Root role has unrestricted access to all resources
 * - Custom role needs explicit snippets for collection config and raw SQL execution
 * - When tenant module is not enabled, original permission behavior is preserved
 *
 * Note: `dbViews:list` and `dbViews:get` are metadata-only actions (list view names,
 * infer fields) and are aliased to `view` in the ACL available actions. The member
 * role's strategy includes `view`, so these actions pass the strategy check. This is
 * by design — `dbViews:query` (which actually executes SQL and returns data) is
 * properly blocked.
 */
import { createMockServer, MockServer } from '@tachybase/test';
import { Database, Plugin, uid } from '@tego/server';

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
}

describe('SQL/View ACL permission boundary', () => {
  let app: MockServer;
  let db: Database;

  beforeAll(async () => {
    app = await createMockServer({
      acl: true,
      registerActions: true,
      database: { dialect: 'sqlite' },
      plugins: [
        'acl',
        'error-handler',
        'users',
        'ui-schema-storage',
        'collection-manager',
        'auth',
        'data-source-manager',
        TestAuthStatusPlugin,
      ],
    });
    db = app.db;

    // Create roles
    const rolesRepo = db.getRepository('roles');

    const adminRole = await rolesRepo.findOne({ filter: { name: 'admin' } });
    if (!adminRole) {
      await rolesRepo.create({
        values: {
          name: 'admin',
          strategy: { actions: ['create', 'view', 'update', 'destroy'] },
          snippets: ['ui.*', 'pm', 'pm.*'],
        },
      });
    }

    const memberRole = await rolesRepo.findOne({ filter: { name: 'member' } });
    if (!memberRole) {
      await rolesRepo.create({
        values: {
          name: 'member',
          strategy: { actions: ['view', 'update:own', 'destroy:own', 'create'] },
          snippets: ['!ui.*', '!pm', '!pm.*'],
        },
      });
    }

    // Create a custom role with explicit snippet for SQL/View access
    const customRole = await rolesRepo.findOne({ filter: { name: 'custom_sql_viewer' } });
    if (!customRole) {
      await rolesRepo.create({
        values: {
          name: 'custom_sql_viewer',
          strategy: { actions: ['view'] },
          snippets: ['pm.database-connections.collections', 'pm.database-connections.sql.execute'],
        },
      });
    }

    // Create users with different roles
    const usersRepo = db.getRepository('users');

    const existingAdmin = await usersRepo.findOne({ filter: { username: 'admin_user' } });
    if (!existingAdmin) {
      await usersRepo.create({
        values: {
          username: 'admin_user',
          email: 'admin-acl@example.com',
          phone: '20000000001',
          password: '123456',
          roles: ['admin'],
        },
      });
    }

    const existingMember = await usersRepo.findOne({ filter: { username: 'member_user' } });
    if (!existingMember) {
      await usersRepo.create({
        values: {
          username: 'member_user',
          email: 'member-acl@example.com',
          phone: '20000000002',
          password: '123456',
          roles: ['member'],
        },
      });
    }

    const existingCustom = await usersRepo.findOne({ filter: { username: 'custom_sql_user' } });
    if (!existingCustom) {
      await usersRepo.create({
        values: {
          username: 'custom_sql_user',
          email: 'custom-sql@example.com',
          phone: '20000000003',
          password: '123456',
          roles: ['custom_sql_viewer'],
        },
      });
    }

    // Ensure root user exists (created by user module install)
    const rootUser = await usersRepo.findOne({ filter: { specialRole: 'root' } });
    if (!rootUser) {
      await usersRepo.create({
        values: {
          username: 'root',
          email: 'root@example.com',
          phone: '20000000000',
          password: '123456',
          specialRole: 'root',
          roles: ['root'],
        },
      });
    }
  });

  afterAll(async () => {
    if (app) {
      await app.destroy();
    }
  });

  describe('sqlCollection:execute (data-execution action)', () => {
    let tableName: string;

    beforeAll(async () => {
      tableName = `acl_test_${uid(6)}`;
      await db.sequelize.query(`CREATE TABLE ${tableName} (id INTEGER, name TEXT)`);
      await db.sequelize.query(`INSERT INTO ${tableName} VALUES (1, 'row_a'), (2, 'row_b')`);
    });

    afterAll(async () => {
      await db.sequelize.query(`DROP TABLE IF EXISTS ${tableName}`);
    });

    it('should deny member role access (403)', async () => {
      const memberUser = await db.getRepository('users').findOne({
        filter: { username: 'member_user' },
      });
      const agent = app.agent().login(memberUser);

      const response = await agent.resource('sqlCollection').execute({
        values: {
          sql: `SELECT * FROM ${tableName}`,
        },
      });

      expect(response.status).toBe(403);
    });

    it('should allow admin role access via snippet', async () => {
      const adminUser = await db.getRepository('users').findOne({
        filter: { username: 'admin_user' },
      });
      const agent = app.agent().login(adminUser);

      const response = await agent.resource('sqlCollection').execute({
        values: {
          sql: `SELECT * FROM ${tableName}`,
        },
      });

      expect(response.status).toBe(200);
      expect(response.body.data.data.length).toBe(2);
    });
  });

  describe('dbViews:query (data-execution action)', () => {
    let viewName: string;

    beforeAll(async () => {
      viewName = `view_acl_test_${uid(6)}`;
      const dropSQL = `DROP VIEW IF EXISTS ${viewName}`;
      await db.sequelize.query(dropSQL);

      const createSQL = db.inDialect('sqlite')
        ? `CREATE VIEW ${viewName} AS SELECT CAST(1 AS INTEGER) AS id, CAST('a' AS TEXT) AS name UNION ALL SELECT CAST(2 AS INTEGER), CAST('b' AS TEXT)`
        : `CREATE VIEW ${viewName} AS SELECT 1 AS id, 'a' AS name UNION ALL SELECT 2, 'b'`;

      await db.sequelize.query(createSQL);
    });

    afterAll(async () => {
      await db.sequelize.query(`DROP VIEW IF EXISTS ${viewName}`);
    });

    it('should deny member role access (403)', async () => {
      const memberUser = await db.getRepository('users').findOne({
        filter: { username: 'member_user' },
      });
      const agent = app.agent().login(memberUser);

      const response = await agent.resource('dbViews').query({
        filterByTk: viewName,
        pageSize: 10,
      });

      expect(response.status).toBe(403);
    });

    it('should allow admin role access via snippet', async () => {
      const adminUser = await db.getRepository('users').findOne({
        filter: { username: 'admin_user' },
      });
      const agent = app.agent().login(adminUser);

      const response = await agent.resource('dbViews').query({
        filterByTk: viewName,
        pageSize: 10,
      });

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBe(2);
    });
  });

  describe('sqlCollection:setFields (configuration action)', () => {
    it('should deny member role access (403)', async () => {
      const memberUser = await db.getRepository('users').findOne({
        filter: { username: 'member_user' },
      });
      const agent = app.agent().login(memberUser);

      const response = await agent.resource('sqlCollection').setFields({
        filterByTk: 'test_collection',
        values: {
          fields: [{ name: 'id', type: 'integer' }],
        },
      });

      expect(response.status).toBe(403);
    });

    it('should allow admin role access via snippet', async () => {
      // Create a test collection for setFields
      const collectionName = `setfields_test_${uid(6)}`;
      await db.getRepository('collections').create({
        values: {
          name: collectionName,
          fields: [{ name: 'id', type: 'integer' }],
        },
      });

      const adminUser = await db.getRepository('users').findOne({
        filter: { username: 'admin_user' },
      });
      const agent = app.agent().login(adminUser);

      const response = await agent.resource('sqlCollection').setFields({
        filterByTk: collectionName,
        values: {
          fields: [
            { name: 'id', type: 'integer' },
            { name: 'name', type: 'string' },
          ],
        },
      });

      expect(response.status).toBe(200);

      // Cleanup
      await db.getRepository('collections').destroy({ filter: { name: collectionName } });
    });
  });

  describe('sqlCollection:update (configuration action)', () => {
    it('should deny member role access (403)', async () => {
      const memberUser = await db.getRepository('users').findOne({
        filter: { username: 'member_user' },
      });
      const agent = app.agent().login(memberUser);

      const response = await agent.resource('sqlCollection').update({
        filterByTk: 'test_collection',
        values: {
          title: 'Updated Title',
        },
      });

      expect(response.status).toBe(403);
    });

    it('should allow admin role access via snippet', async () => {
      // Create a test collection for update
      const collectionName = `update_test_${uid(6)}`;
      await db.getRepository('collections').create({
        values: {
          name: collectionName,
          title: 'Original Title',
          fields: [{ name: 'id', type: 'integer' }],
        },
      });

      const adminUser = await db.getRepository('users').findOne({
        filter: { username: 'admin_user' },
      });
      const agent = app.agent().login(adminUser);

      const response = await agent.resource('sqlCollection').update({
        filterByTk: collectionName,
        values: {
          title: 'Updated Title',
        },
      });

      expect(response.status).toBe(200);

      // Cleanup
      await db.getRepository('collections').destroy({ filter: { name: collectionName } });
    });
  });

  describe('dbViews:get (metadata action)', () => {
    let viewName: string;

    beforeAll(async () => {
      viewName = `view_meta_test_${uid(6)}`;
      const dropSQL = `DROP VIEW IF EXISTS ${viewName}`;
      await db.sequelize.query(dropSQL);

      const createSQL = db.inDialect('sqlite')
        ? `CREATE VIEW ${viewName} AS SELECT CAST(1 AS INTEGER) AS id, CAST('test' AS TEXT) AS name`
        : `CREATE VIEW ${viewName} AS SELECT 1 AS id, 'test' AS name`;

      await db.sequelize.query(createSQL);
    });

    afterAll(async () => {
      await db.sequelize.query(`DROP VIEW IF EXISTS ${viewName}`);
    });

    it('should allow member role access (metadata-only, maps to view strategy)', async () => {
      const memberUser = await db.getRepository('users').findOne({
        filter: { username: 'member_user' },
      });
      const agent = app.agent().login(memberUser);

      const response = await agent.resource('dbViews').get({
        filterByTk: viewName,
      });

      // get is a metadata action that maps to 'view' in strategy
      // member role has 'view' in their strategy, so this should pass
      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(response.body.data.fields).toBeDefined();
    });

    it('should allow admin role access', async () => {
      const adminUser = await db.getRepository('users').findOne({
        filter: { username: 'admin_user' },
      });
      const agent = app.agent().login(adminUser);

      const response = await agent.resource('dbViews').get({
        filterByTk: viewName,
      });

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(response.body.data.fields).toBeDefined();
    });
  });

  describe('root role access (unrestricted)', () => {
    let tableName: string;
    let viewName: string;

    beforeAll(async () => {
      tableName = `root_test_${uid(6)}`;
      await db.sequelize.query(`CREATE TABLE ${tableName} (id INTEGER, name TEXT)`);
      await db.sequelize.query(`INSERT INTO ${tableName} VALUES (1, 'root_row')`);

      viewName = `view_root_test_${uid(6)}`;
      const createSQL = db.inDialect('sqlite')
        ? `CREATE VIEW ${viewName} AS SELECT CAST(1 AS INTEGER) AS id, CAST('root' AS TEXT) AS name`
        : `CREATE VIEW ${viewName} AS SELECT 1 AS id, 'root' AS name`;
      await db.sequelize.query(createSQL);
    });

    afterAll(async () => {
      await db.sequelize.query(`DROP TABLE IF EXISTS ${tableName}`);
      await db.sequelize.query(`DROP VIEW IF EXISTS ${viewName}`);
    });

    it('should allow root to execute sqlCollection', async () => {
      const rootUser = await db.getRepository('users').findOne({
        filter: { specialRole: 'root' },
      });
      const agent = app.agent().login(rootUser);

      const response = await agent.resource('sqlCollection').execute({
        values: {
          sql: `SELECT * FROM ${tableName}`,
        },
      });

      expect(response.status).toBe(200);
      expect(response.body.data.data.length).toBeGreaterThan(0);
    });

    it('should allow root to query dbViews', async () => {
      const rootUser = await db.getRepository('users').findOne({
        filter: { specialRole: 'root' },
      });
      const agent = app.agent().login(rootUser);

      const response = await agent.resource('dbViews').query({
        filterByTk: viewName,
        pageSize: 10,
      });

      expect(response.status).toBe(200);
    });

    it('should allow root to list dbViews', async () => {
      const rootUser = await db.getRepository('users').findOne({
        filter: { specialRole: 'root' },
      });
      const agent = app.agent().login(rootUser);

      const response = await agent.resource('dbViews').list();

      expect(response.status).toBe(200);
    });
  });

  describe('custom role with explicit snippet', () => {
    let tableName: string;
    let viewName: string;

    beforeAll(async () => {
      tableName = `custom_test_${uid(6)}`;
      await db.sequelize.query(`CREATE TABLE ${tableName} (id INTEGER, name TEXT)`);
      await db.sequelize.query(`INSERT INTO ${tableName} VALUES (1, 'custom_row')`);

      viewName = `view_custom_test_${uid(6)}`;
      const createSQL = db.inDialect('sqlite')
        ? `CREATE VIEW ${viewName} AS SELECT CAST(1 AS INTEGER) AS id, CAST('custom' AS TEXT) AS name`
        : `CREATE VIEW ${viewName} AS SELECT 1 AS id, 'custom' AS name`;
      await db.sequelize.query(createSQL);
    });

    afterAll(async () => {
      await db.sequelize.query(`DROP TABLE IF EXISTS ${tableName}`);
      await db.sequelize.query(`DROP VIEW IF EXISTS ${viewName}`);
    });

    it('should allow custom_sql_viewer role to execute sqlCollection via explicit snippet', async () => {
      const customUser = await db.getRepository('users').findOne({
        filter: { username: 'custom_sql_user' },
      });
      const agent = app.agent().login(customUser);

      const response = await agent.resource('sqlCollection').execute({
        values: {
          sql: `SELECT * FROM ${tableName}`,
        },
      });

      expect(response.status).toBe(200);
      expect(response.body.data.data.length).toBeGreaterThan(0);
    });

    it('should allow custom_sql_viewer role to query dbViews via explicit snippet', async () => {
      const customUser = await db.getRepository('users').findOne({
        filter: { username: 'custom_sql_user' },
      });
      const agent = app.agent().login(customUser);

      const response = await agent.resource('dbViews').query({
        filterByTk: viewName,
        pageSize: 10,
      });

      expect(response.status).toBe(200);
    });

    it('should verify custom_sql_viewer role has collection and SQL execute snippets', () => {
      const customRole = app.acl.getRole('custom_sql_viewer');
      expect(customRole).toBeDefined();
      const { allowed } = customRole.effectiveSnippets();
      expect(allowed).toContain('pm.database-connections.collections');
      expect(allowed).toContain('pm.database-connections.sql.execute');
    });
  });

  describe('sqlCollection snippet registration', () => {
    it('should keep sqlCollection execute out of the collection configuration snippet', () => {
      const snippet = app.acl.snippetManager.snippets.get('pm.database-connections.collections');
      expect(snippet).toBeDefined();
      expect(snippet.actions).toContain('sqlCollection:update');
      expect(snippet.actions).toContain('sqlCollection:setFields');
      expect(snippet.actions).not.toContain('sqlCollection:*');
      expect(snippet.actions).not.toContain('sqlCollection:execute');
    });

    it('should register sqlCollection execute as a separate snippet', () => {
      const snippet = app.acl.snippetManager.snippets.get('pm.database-connections.sql.execute');
      expect(snippet).toBeDefined();
      expect(snippet.actions).toContain('sqlCollection:execute');
    });

    it('should include dbViews:* in pm.database-connections.collections snippet', () => {
      const snippet = app.acl.snippetManager.snippets.get('pm.database-connections.collections');
      expect(snippet).toBeDefined();
      expect(snippet.actions).toContain('dbViews:*');
    });
  });
});

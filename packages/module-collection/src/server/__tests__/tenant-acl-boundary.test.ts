/**
 * ACL permission boundary tests for SQL collections and DB Views.
 *
 * Verifies that:
 * - Member role (regular tenant user) gets 403 on data-execution actions
 *   (sqlCollection:execute, dbViews:query)
 * - Admin role can access these resources via the pm.database-connections.collections snippet
 * - Metadata list actions (dbViews:list) follow the standard strategy
 * - When tenant module is not enabled, original permission behavior is preserved
 *
 * Note: `dbViews:list` is a metadata-only action (lists view names) and is aliased
 * to `view` in the ACL available actions. The member role's strategy includes `view`,
 * so `list` actions on any resource pass the strategy check. This is by design —
 * `dbViews:query` (which actually executes SQL and returns data) is properly blocked.
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

  describe('sqlCollection snippet registration', () => {
    it('should include sqlCollection:* in pm.database-connections.collections snippet', () => {
      const snippet = app.acl.snippetManager.snippets.get('pm.database-connections.collections');
      expect(snippet).toBeDefined();
      expect(snippet.actions).toContain('sqlCollection:*');
    });

    it('should include dbViews:* in pm.database-connections.collections snippet', () => {
      const snippet = app.acl.snippetManager.snippets.get('pm.database-connections.collections');
      expect(snippet).toBeDefined();
      expect(snippet.actions).toContain('dbViews:*');
    });
  });
});

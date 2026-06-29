/**
 * ACL permission boundary tests for SQL instruction nodes in workflows.
 *
 * Verifies that:
 * - Member role (regular tenant user) cannot create SQL nodes via the API (403)
 * - Admin role can create SQL nodes via the API
 * - Non-SQL node types can still be created by any role with workflow access
 * - The pm.workflow.sql snippet is registered and covered by pm.* for admin/root
 */
import { createMockServer, MockServer } from '@tachybase/test';
import { Database, Plugin } from '@tego/server';

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

    // Update or create admin role with pm.* snippet
    const existingAdmin = await rolesRepository.findOne({ filter: { name: 'admin' } });
    if (existingAdmin) {
      await existingAdmin.update({
        allowConfigure: true,
        strategy: { actions: ['create', 'view', 'update', 'destroy'] },
        snippets: ['ui.*', 'pm', 'pm.*'],
      });
    } else {
      await rolesRepository.create({
        values: {
          name: 'admin',
          title: 'Admin',
          allowConfigure: true,
          strategy: { actions: ['create', 'view', 'update', 'destroy'] },
          snippets: ['ui.*', 'pm', 'pm.*'],
        },
      });
    }

    // Update or create member role
    const existingMember = await rolesRepository.findOne({ filter: { name: 'member' } });
    if (existingMember) {
      await existingMember.update({
        strategy: { actions: ['view', 'update:own', 'destroy:own', 'create'] },
        snippets: ['!ui.*', '!pm', '!pm.*', 'pm.workflow.workflows'],
      });
    } else {
      await rolesRepository.create({
        values: {
          name: 'member',
          title: 'Member',
          strategy: { actions: ['view', 'update:own', 'destroy:own', 'create'] },
          snippets: ['!ui.*', '!pm', '!pm.*', 'pm.workflow.workflows'],
        },
      });
    }

    // Create users (defensive)
    const usersRepository = this.app.db.getRepository('users');
    const existingAdminUser = await usersRepository.findOne({ filter: { username: 'wf_admin' } });
    if (!existingAdminUser) {
      await usersRepository.create({
        values: {
          username: 'wf_admin',
          email: 'wf-admin@example.com',
          phone: '30000000001',
          password: '123456',
          roles: ['admin'],
        },
      });
    }
    const existingMemberUser = await usersRepository.findOne({ filter: { username: 'wf_member' } });
    if (!existingMemberUser) {
      await usersRepository.create({
        values: {
          username: 'wf_member',
          email: 'wf-member@example.com',
          phone: '30000000002',
          password: '123456',
          roles: ['member'],
        },
      });
    }
  }
}

describe('workflow > sql instruction permission boundary', () => {
  let app: MockServer;
  let db: Database;
  let WorkflowModel;

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
        'workflow',
        'workflow-test',
        TestAuthStatusPlugin,
      ],
    });
    db = app.db;
    WorkflowModel = db.getCollection('workflows').model;
  });

  afterAll(async () => {
    if (app) {
      await app.destroy();
    }
  });

  beforeEach(async () => {
    await db.getRepository('workflows').destroy({ filter: {} });
  });

  describe('pm.workflow.sql snippet', () => {
    it('should be registered', () => {
      const snippet = app.acl.snippetManager.snippets.get('pm.workflow.sql');
      expect(snippet).toBeDefined();
    });

    it('should be covered by pm.* for admin role', () => {
      const adminRole = app.acl.getRole('admin');
      expect(adminRole).toBeDefined();
      const { allowed } = adminRole.effectiveSnippets();
      expect(allowed).toContain('pm.workflow.sql');
    });

    it('should not be covered for member role with !pm.*', () => {
      const memberRole = app.acl.getRole('member');
      expect(memberRole).toBeDefined();
      const { allowed } = memberRole.effectiveSnippets();
      expect(allowed).not.toContain('pm.workflow.sql');
    });
  });

  describe('SQL node creation via API', () => {
    it('should deny member role creating SQL nodes (403)', async () => {
      const memberUser = await db.getRepository('users').findOne({
        filter: { username: 'wf_member' },
      });
      const agent = app.agent().login(memberUser);

      const workflow = await WorkflowModel.create({
        enabled: false,
        type: 'collection',
        config: { collection: 'posts', mode: 1 },
      });

      const response = await agent.resource('workflows.nodes', workflow.id).create({
        values: {
          type: 'sql',
          config: {
            sql: 'SELECT 1',
          },
        },
      });

      expect(response.status).toBe(403);
    });

    it('should allow admin role creating SQL nodes', async () => {
      const adminUser = await db.getRepository('users').findOne({
        filter: { username: 'wf_admin' },
      });
      const agent = app.agent().login(adminUser);

      const workflow = await WorkflowModel.create({
        enabled: false,
        type: 'collection',
        config: { collection: 'posts', mode: 1 },
      });

      const response = await agent.resource('workflows.nodes', workflow.id).create({
        values: {
          type: 'sql',
          config: {
            sql: 'SELECT 1',
          },
        },
      });

      expect(response.status).toBe(200);
    });
  });

  describe('SQL node update via API', () => {
    it('should deny member role updating SQL node config (403)', async () => {
      const adminUser = await db.getRepository('users').findOne({
        filter: { username: 'wf_admin' },
      });
      const adminAgent = app.agent().login(adminUser);
      const workflow = await WorkflowModel.create({
        enabled: false,
        type: 'collection',
        config: { collection: 'posts', mode: 1 },
      });
      const createRes = await adminAgent.resource('workflows.nodes', workflow.id).create({
        values: {
          type: 'sql',
          config: { sql: 'SELECT 1' },
        },
      });
      const nodeId = createRes.body.data.id;

      const memberUser = await db.getRepository('users').findOne({
        filter: { username: 'wf_member' },
      });
      const agent = app.agent().login(memberUser);

      const response = await agent.resource('flow_nodes').update({
        filterByTk: nodeId,
        values: {
          config: { sql: 'SELECT * FROM users' },
        },
      });

      expect(response.status).toBe(403);
    });
  });

  describe('non-SQL node types', () => {
    it('should not be blocked by SQL permission guard for member role', async () => {
      const memberUser = await db.getRepository('users').findOne({
        filter: { username: 'wf_member' },
      });
      const agent = app.agent().login(memberUser);

      const workflow = await WorkflowModel.create({
        enabled: false,
        type: 'collection',
        config: { collection: 'posts', mode: 1 },
      });

      const response = await agent.resource('workflows.nodes', workflow.id).create({
        values: {
          type: 'calculation',
          config: {
            calculation: '1 + 1',
          },
        },
      });

      // Should not be blocked by SQL permission guard
      expect(response.status).not.toBe(403);
    });
  });
});

/**
 * ACL permission boundary tests for SQL instruction nodes in workflows.
 *
 * Verifies that:
 * - Member role (regular tenant user) cannot create SQL nodes via the API (403)
 * - Admin role can create SQL nodes via the API
 * - Non-SQL node types can still be created by any role with workflow access
 * - The pm.workflow.sql snippet is registered and covered by pm.* for admin/root
 * - Member role cannot execute SQL instructions at runtime (execution-level guard)
 * - Admin role can execute SQL instructions at runtime
 * - Internal triggers (no httpContext) can still execute SQL instructions
 */
import { createMockServer, MockServer } from '@tachybase/test';
import { Database, Plugin } from '@tego/server';

import { EXECUTION_STATUS, JOB_STATUS } from '../../constants';
import type WorkflowPlugin from '../../Plugin';
import { triggerWorkflowAndGetExecution } from '../../utils';

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

  describe('SQL instruction execution permission', () => {
    const MARKER_TABLE = 'sql_exec_test_markers';

    beforeEach(async () => {
      // Create a marker table to track SQL execution side effects
      await db.sequelize.query(`CREATE TABLE IF NOT EXISTS ${MARKER_TABLE} (id INTEGER PRIMARY KEY, label TEXT)`);
      await db.sequelize.query(`DELETE FROM ${MARKER_TABLE}`);
    });

    afterEach(async () => {
      await db.sequelize.query(`DROP TABLE IF EXISTS ${MARKER_TABLE}`);
    });

    describe('via real API (workflows:test action)', () => {
      it('admin should execute SQL instruction through real API', async () => {
        const adminUser = await db.getRepository('users').findOne({
          filter: { username: 'wf_admin' },
        });
        const agent = app.agent().login(adminUser);

        // Create a sync workflow with SQL node
        const workflow = await WorkflowModel.create({
          enabled: false,
          sync: true,
          type: 'collection',
          config: { collection: 'posts', mode: 1 },
        });
        await workflow.createNode({
          type: 'sql',
          config: {
            sql: `INSERT INTO ${MARKER_TABLE} (id, label) VALUES (1, 'admin-api-executed')`,
          },
        });

        // Trigger via real API action (passes full Koa context as httpContext)
        const response = await agent.resource('workflows').test({
          filterByTk: workflow.id,
          values: { data: {} },
        });

        expect(response.status).toBe(200);

        const execution = response.body?.data;
        expect(execution).toBeDefined();
        // EXECUTION_STATUS.RESOLVED = 1
        expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);

        // Verify the SQL actually ran by checking the job result
        const jobs = await db.getRepository('jobs').find({
          filter: { executionId: execution.id },
        });
        expect(jobs.length).toBeGreaterThan(0);
        const sqlJob = jobs[0];
        // JOB_STATUS.RESOLVED = 1
        expect(sqlJob.get('status')).toBe(JOB_STATUS.RESOLVED);
      });

      it('member should be denied executing SQL instruction through real API (403)', async () => {
        const memberUser = await db.getRepository('users').findOne({
          filter: { username: 'wf_member' },
        });
        const agent = app.agent().login(memberUser);

        // Create a sync workflow with SQL node
        const workflow = await WorkflowModel.create({
          enabled: false,
          sync: true,
          type: 'collection',
          config: { collection: 'posts', mode: 1 },
        });
        await workflow.createNode({
          type: 'sql',
          config: {
            sql: `INSERT INTO ${MARKER_TABLE} (id, label) VALUES (1, 'member-api-executed')`,
          },
        });

        // Member tries to trigger via real API — ACL should deny
        const response = await agent.resource('workflows').test({
          filterByTk: workflow.id,
          values: { data: {} },
        });

        // workflows:test requires pm.workflow.sql (via workflows:*), member has !pm.*
        // ACL blocks at the action level
        expect(response.status).toBe(403);

        // SQL should NOT have executed
        const [markers] = await db.sequelize.query(`SELECT * FROM ${MARKER_TABLE}`);
        expect(markers).toHaveLength(0);
      });
    });

    describe('via direct trigger (processor-level check)', () => {
      it('should deny member executing SQL instruction (fail-closed)', async () => {
        const memberUser = await db.getRepository('users').findOne({
          filter: { username: 'wf_member' },
        });

        // Create a sync workflow with SQL node
        const workflow = await WorkflowModel.create({
          enabled: false,
          sync: true,
          type: 'collection',
          config: { collection: 'posts', mode: 1 },
        });
        await workflow.createNode({
          type: 'sql',
          config: {
            sql: `INSERT INTO ${MARKER_TABLE} (id, label) VALUES (1, 'member-executed')`,
          },
        });

        // Get the plugin instance
        const plugin = app.pm.get('workflow') as WorkflowPlugin;

        // Trigger with member's httpContext (simulating API trigger with member role)
        const memberCtx = {
          state: { currentRole: 'member', currentUser: memberUser },
          app: app,
        };
        const execution = await triggerWorkflowAndGetExecution(
          plugin,
          workflow,
          { data: {}, user: memberUser },
          { httpContext: memberCtx },
          db,
        );

        expect(execution).toBeDefined();

        // SQL should NOT have executed - marker table should be empty
        const [markers] = await db.sequelize.query(`SELECT * FROM ${MARKER_TABLE}`);
        expect(markers).toHaveLength(0);

        // Execution should show error status (EXECUTION_STATUS.ERROR = -2)
        expect(execution.get('status')).toBe(EXECUTION_STATUS.ERROR);

        // The job should contain a permission error message
        const jobs = await db.getRepository('jobs').find({
          filter: { executionId: execution.id },
        });
        expect(jobs.length).toBeGreaterThan(0);
        const failedJob = jobs.find((j) => j.get('status') === JOB_STATUS.ERROR);
        expect(failedJob).toBeDefined();
        const result = failedJob.get('result');
        expect(result?.message).toMatch(/pm\.workflow\.sql/);
      });

      it('should allow admin executing SQL instruction', async () => {
        const adminUser = await db.getRepository('users').findOne({
          filter: { username: 'wf_admin' },
        });

        // Create a sync workflow with SQL node
        const workflow = await WorkflowModel.create({
          enabled: false,
          sync: true,
          type: 'collection',
          config: { collection: 'posts', mode: 1 },
        });
        await workflow.createNode({
          type: 'sql',
          config: {
            sql: `INSERT INTO ${MARKER_TABLE} (id, label) VALUES (1, 'admin-executed')`,
          },
        });

        // Get the plugin instance
        const plugin = app.pm.get('workflow') as WorkflowPlugin;

        // Trigger with admin's httpContext
        const adminCtx = {
          state: { currentRole: 'admin', currentUser: adminUser },
          app: app,
        };
        const execution = await triggerWorkflowAndGetExecution(
          plugin,
          workflow,
          { data: {}, user: adminUser },
          { httpContext: adminCtx },
          db,
        );

        expect(execution).toBeDefined();

        // SQL SHOULD have executed - marker should exist
        const [markers] = await db.sequelize.query(`SELECT * FROM ${MARKER_TABLE} WHERE id = 1`);
        expect(markers).toHaveLength(1);
        expect((markers[0] as any).label).toBe('admin-executed');

        // Execution should show resolved status
        expect(execution.get('status')).toBe(EXECUTION_STATUS.RESOLVED);
      });

      it('should allow SQL execution without httpContext (internal trigger)', async () => {
        // Internal triggers (collection events, schedule, etc.) don't have httpContext.
        // They are allowed because the SQL node was already permission-gated at creation.

        // Create a sync workflow with SQL node
        const workflow = await WorkflowModel.create({
          enabled: false,
          sync: true,
          type: 'collection',
          config: { collection: 'posts', mode: 1 },
        });
        await workflow.createNode({
          type: 'sql',
          config: {
            sql: `INSERT INTO ${MARKER_TABLE} (id, label) VALUES (1, 'internal-trigger')`,
          },
        });

        // Get the plugin instance
        const plugin = app.pm.get('workflow') as WorkflowPlugin;

        // Trigger WITHOUT httpContext (simulating internal trigger like collection event)
        const execution = await triggerWorkflowAndGetExecution(plugin, workflow, { data: {} }, {}, db);

        expect(execution).toBeDefined();

        // SQL should have executed (internal triggers are trusted)
        const [markers] = await db.sequelize.query(`SELECT * FROM ${MARKER_TABLE} WHERE id = 1`);
        expect(markers).toHaveLength(1);
        expect((markers[0] as any).label).toBe('internal-trigger');

        expect(execution.get('status')).toBe(EXECUTION_STATUS.RESOLVED);
      });
    });
  });
});

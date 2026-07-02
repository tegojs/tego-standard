/**
 * Tenant isolation boundary tests for SQL collections, View collections,
 * and Workflow SQL instruction.
 *
 * These tests verify that SQL/View collections and the workflow SQL instruction
 * do NOT automatically inject tenantId filtering — by design.
 */
import { MockServer } from '@tachybase/test';
import { Database, uid } from '@tego/server';

import { createApp } from './index';

describe('SQL/View tenant isolation boundary', () => {
  let app: MockServer;
  let db: Database;
  let agent;

  beforeEach(async () => {
    app = await createApp({
      database: {
        tablePrefix: '',
      },
    });
    db = app.db;
    agent = app.agent();
  });

  afterEach(async () => {
    if (app) {
      await app.destroy();
    }
  });

  describe('dbViews:query does not inject tenantId', () => {
    it('should execute raw SELECT without tenant filtering', async () => {
      const viewName = `view_tenant_test_${uid(6)}`;
      const dropSQL = `DROP VIEW IF EXISTS ${viewName}`;

      await db.sequelize.query(dropSQL);

      const createSQL = (() => {
        if (db.inDialect('sqlite')) {
          return `CREATE VIEW ${viewName} AS SELECT CAST(1 AS INTEGER) AS id, CAST('a' AS TEXT) AS name UNION ALL SELECT CAST(2 AS INTEGER), CAST('b' AS TEXT)`;
        }
        return `CREATE VIEW ${viewName} AS SELECT 1 AS id, 'a' AS name UNION ALL SELECT 2, 'b'`;
      })();

      await db.sequelize.query(createSQL);

      try {
        const response = await agent.resource('dbViews').query({
          filterByTk: viewName,
          pageSize: 10,
        });

        expect(response.status).toBe(200);
        // The query returns ALL rows — no tenantId filtering is applied.
        // This is by design: view collections do not support tenancy.
        expect(response.body.data.length).toBe(2);
        expect(response.body.data[0]).toHaveProperty('id');
        expect(response.body.data[0]).toHaveProperty('name');
      } finally {
        await db.sequelize.query(dropSQL);
      }
    });
  });

  describe('sqlCollection:execute does not inject tenantId', () => {
    it('should execute SELECT without tenant filtering', async () => {
      // Create a simple table to query against
      const tableName = `test_tenant_${uid(6)}`;
      await db.sequelize.query(`CREATE TABLE ${tableName} (id INTEGER, name TEXT)`);
      await db.sequelize.query(`INSERT INTO ${tableName} VALUES (1, 'tenant_a'), (2, 'tenant_b')`);

      try {
        const response = await agent.resource('sqlCollection').execute({
          values: {
            sql: `SELECT * FROM ${tableName}`,
          },
        });

        expect(response.status).toBe(200);
        // The SQL is executed as-is — no tenantId filtering is injected.
        // This is by design: SQL collections do not support tenancy.
        expect(response.body.data.data.length).toBe(2);
      } finally {
        await db.sequelize.query(`DROP TABLE IF EXISTS ${tableName}`);
      }
    });

    it('should reject non-SELECT statements', async () => {
      const response = await agent.resource('sqlCollection').execute({
        values: {
          sql: 'DROP TABLE IF EXISTS nonexistent',
        },
      });

      expect(response.status).toBe(400);
    });

    it('should reject writable CTE statements in preview queries', async () => {
      const tableName = `test_tenant_${uid(6)}`;
      await db.sequelize.query(`CREATE TABLE ${tableName} (id INTEGER, name TEXT)`);

      try {
        const response = await agent.resource('sqlCollection').execute({
          values: {
            sql: `WITH inserted AS (INSERT INTO ${tableName} VALUES (1, 'tenant_a') RETURNING *) SELECT * FROM inserted`,
          },
        });

        expect(response.status).toBe(400);
      } finally {
        await db.sequelize.query(`DROP TABLE IF EXISTS ${tableName}`);
      }
    });
  });
});

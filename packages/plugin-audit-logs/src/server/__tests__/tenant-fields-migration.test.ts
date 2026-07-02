import { createMockServer, type MockServer } from '@tachybase/test';
import { DataTypes, type MigrationContext } from '@tego/server';

import TenantFieldsMigration from '../migrations/20260617203100-add-tenant-fields';

describe('audit log tenant fields migration', () => {
  let app: MockServer;

  beforeEach(async () => {
    app = await createMockServer();
  });

  afterEach(async () => {
    await app.destroy();
  });

  it('should add tenant audit fields to existing auditLogs table idempotently', async () => {
    const queryInterface = app.db.sequelize.getQueryInterface();

    await queryInterface.createTable('auditLogs', {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      createdAt: {
        type: DataTypes.DATE,
      },
      updatedAt: {
        type: DataTypes.DATE,
      },
    });

    const migration = new TenantFieldsMigration({ db: app.db } as MigrationContext);
    migration.context.app = app;

    await migration.up();
    await migration.up();

    const table = await queryInterface.describeTable('auditLogs');
    expect(table.tenantId).toBeDefined();
    expect(table.actorUserId).toBeDefined();
    expect(table.actorUserId.type).toContain('VARCHAR');
    expect(table.impersonatedTenantId).toBeDefined();
    expect(table.tenantContextSource).toBeDefined();
    expect(table.isTenantImpersonation).toBeDefined();
  });

  it('should not duplicate indexes when an existing index covers the same column', async () => {
    const queryInterface = app.db.sequelize.getQueryInterface();

    await queryInterface.createTable('auditLogs', {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      tenantId: {
        type: DataTypes.STRING,
      },
      createdAt: {
        type: DataTypes.DATE,
      },
      updatedAt: {
        type: DataTypes.DATE,
      },
    });
    await queryInterface.addIndex('auditLogs', ['tenantId'], { name: 'audit_logs_existing_tenant_idx' });

    const migration = new TenantFieldsMigration({ db: app.db } as MigrationContext);
    migration.context.app = app;

    await migration.up();

    const indexes = await queryInterface.showIndex('auditLogs');
    const tenantIdIndexes = indexes.filter((index: any) =>
      index.fields?.some((field: any) => field.attribute === 'tenantId' || field.name === 'tenantId'),
    );
    expect(tenantIdIndexes).toHaveLength(1);
  });
});

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
    expect(table.impersonatedTenantId).toBeDefined();
    expect(table.tenantContextSource).toBeDefined();
    expect(table.isTenantImpersonation).toBeDefined();
  });
});

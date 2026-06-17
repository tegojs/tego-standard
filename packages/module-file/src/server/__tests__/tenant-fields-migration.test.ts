import { createMockServer, type MockServer } from '@tachybase/test';
import { DataTypes, type MigrationContext } from '@tego/server';

import TenantFieldsMigration from '../migrations/20260617203200-add-tenant-fields';

describe('file tenant fields migration', () => {
  let app: MockServer;

  beforeEach(async () => {
    app = await createMockServer();
  });

  afterEach(async () => {
    await app.destroy();
  });

  it('should add tenantId to existing attachments table idempotently', async () => {
    const queryInterface = app.db.sequelize.getQueryInterface();

    await queryInterface.createTable('attachments', {
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

    const table = await queryInterface.describeTable('attachments');
    expect(table.tenantId).toBeDefined();
  });
});

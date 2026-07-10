import { createMockServer, type MockServer } from '@tachybase/test';
import { DataTypes, type MigrationContext } from '@tego/server';

import { COLLECTION_NAME_APPROVAL_CARBON_COPY } from '../../common/constants';
import TenantFieldsMigration from '../migrations/20260630120000-add-tenant-fields';

describe('workflow approval tenant fields migration', () => {
  let app: MockServer;

  beforeEach(async () => {
    app = await createMockServer();
  });

  afterEach(async () => {
    await app.destroy();
  });

  it('should add tenantId to approval runtime tables idempotently', async () => {
    const queryInterface = app.db.sequelize.getQueryInterface();
    const tableNames = ['approvals', 'approvalRecords', 'approvalExecutions', COLLECTION_NAME_APPROVAL_CARBON_COPY];

    for (const tableName of tableNames) {
      await queryInterface.createTable(tableName, {
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
    }

    const migration = new TenantFieldsMigration({ db: app.db } as MigrationContext);
    migration.context.app = app;

    await migration.up();
    await migration.up();

    for (const tableName of tableNames) {
      const table = await queryInterface.describeTable(tableName);
      expect(table.tenantId).toBeDefined();
    }
  });
});

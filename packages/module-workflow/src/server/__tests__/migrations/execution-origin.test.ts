import { createMockServer, type MockServer } from '@tachybase/test';
import { DataTypes, type MigrationContext } from '@tego/server';

import ExecutionOriginMigration from '../../migrations/20260813143000-add-execution-origin';

describe('workflow execution origin migration', () => {
  let app: MockServer;

  beforeEach(async () => {
    app = await createMockServer();
  });

  afterEach(async () => {
    await app.destroy();
  });

  it('should add and remove the execution origin column idempotently', async () => {
    const queryInterface = app.db.sequelize.getQueryInterface();
    await queryInterface.createTable('executions', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    });
    const migration = new ExecutionOriginMigration({ db: app.db } as MigrationContext);
    migration.context.app = app;

    await migration.up();
    await migration.up();
    expect((await queryInterface.describeTable('executions')).executionOrigin).toBeDefined();

    await migration.down();
    await migration.down();
    expect((await queryInterface.describeTable('executions')).executionOrigin).toBeUndefined();
  });

  it('should use the physical column name for underscored databases', async () => {
    await app.destroy();
    app = await createMockServer({ database: { underscored: true } });
    const queryInterface = app.db.sequelize.getQueryInterface();
    await queryInterface.createTable('executions', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    });
    const migration = new ExecutionOriginMigration({ db: app.db } as MigrationContext);
    migration.context.app = app;

    await migration.up();

    expect((await queryInterface.describeTable('executions')).execution_origin).toBeDefined();
  });
});

import { createMockServer, type MockServer } from '@tachybase/test';
import { DataTypes, type MigrationContext } from '@tego/server';

import TenantFieldsMigration from '../../migrations/20260617203000-add-tenant-fields';

describe('workflow tenant fields migration', () => {
  let app: MockServer;

  beforeEach(async () => {
    app = await createMockServer();
  });

  afterEach(async () => {
    await app.destroy();
  });

  it('should add tenant fields to existing executions table idempotently', async () => {
    const queryInterface = app.db.sequelize.getQueryInterface();

    await queryInterface.createTable('executions', {
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
      key: {
        type: DataTypes.STRING,
      },
    });

    const migration = new TenantFieldsMigration({ db: app.db } as MigrationContext);
    migration.context.app = app;

    await migration.up();
    await migration.up();

    const table = await queryInterface.describeTable('executions');
    expect(table.tenantId).toBeDefined();
    expect(table.tenantContext).toBeDefined();

    const indexes = await queryInterface.showIndex('executions');
    expect(indexes.some((index) => index.name === 'executions_tenant_key_created_at')).toBe(true);
  });

  it('should remove tenant fields and indexes on rollback', async () => {
    const queryInterface = app.db.sequelize.getQueryInterface();

    await queryInterface.createTable('executions', {
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
      key: {
        type: DataTypes.STRING,
      },
    });

    const migration = new TenantFieldsMigration({ db: app.db } as MigrationContext);
    migration.context.app = app;

    await migration.up();
    await migration.down();
    await migration.down();

    const table = await queryInterface.describeTable('executions');
    expect(table.tenantId).toBeUndefined();
    expect(table.tenantContext).toBeUndefined();
    expect(table.authContext).toBeUndefined();

    const indexes = await queryInterface.showIndex('executions');
    expect(indexes.some((index) => index.name === 'executions_tenant_id')).toBe(false);
    expect(indexes.some((index) => index.name === 'executions_tenant_key_created_at')).toBe(false);
  });

  it('should use physical identifiers when database naming is underscored', async () => {
    await app.destroy();
    app = await createMockServer({ database: { underscored: true } });
    const queryInterface = app.db.sequelize.getQueryInterface();

    await queryInterface.createTable('executions', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      created_at: { type: DataTypes.DATE },
      updated_at: { type: DataTypes.DATE },
      key: { type: DataTypes.STRING },
    });

    const migration = new TenantFieldsMigration({ db: app.db } as MigrationContext);
    migration.context.app = app;

    await migration.up();

    const table = await queryInterface.describeTable('executions');
    expect(table.tenant_id).toBeDefined();
    expect(table.tenant_context).toBeDefined();
    expect(table.auth_context).toBeDefined();
  });
});

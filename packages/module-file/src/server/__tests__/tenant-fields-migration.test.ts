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

  it('should backfill legacy attachment tenantId from uploader tenant membership', async () => {
    const queryInterface = app.db.sequelize.getQueryInterface();

    await queryInterface.createTable('users', {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
      },
      defaultTenantId: {
        type: DataTypes.STRING,
      },
    });
    await queryInterface.createTable('tenantUsers', {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      userId: {
        type: DataTypes.INTEGER,
      },
      tenantId: {
        type: DataTypes.STRING,
      },
    });
    await queryInterface.createTable('attachments', {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
      },
      createdById: {
        type: DataTypes.INTEGER,
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

    await queryInterface.bulkInsert('users', [
      { id: 1, defaultTenantId: 'tenant-default' },
      { id: 2, defaultTenantId: null },
    ]);
    await queryInterface.bulkInsert('tenantUsers', [{ userId: 2, tenantId: 'tenant-membership' }]);
    await queryInterface.bulkInsert('attachments', [
      { id: 1, createdById: 1, tenantId: null },
      { id: 2, createdById: 2, tenantId: null },
      { id: 3, createdById: 1, tenantId: 'tenant-existing' },
    ]);

    const migration = new TenantFieldsMigration({ db: app.db } as MigrationContext);
    migration.context.app = app;

    await migration.up();

    const [rows] = (await app.db.sequelize.query('select id, tenantId from attachments order by id')) as any;
    expect(rows).toEqual([
      { id: 1, tenantId: 'tenant-default' },
      { id: 2, tenantId: 'tenant-membership' },
      { id: 3, tenantId: 'tenant-existing' },
    ]);
  });

  it('should leave tenantId empty when uploader has multiple tenant memberships', async () => {
    const queryInterface = app.db.sequelize.getQueryInterface();

    await queryInterface.createTable('users', {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
      },
      defaultTenantId: {
        type: DataTypes.STRING,
      },
    });
    await queryInterface.createTable('tenantUsers', {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      userId: {
        type: DataTypes.INTEGER,
      },
      tenantId: {
        type: DataTypes.STRING,
      },
    });
    await queryInterface.createTable('attachments', {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
      },
      createdById: {
        type: DataTypes.INTEGER,
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

    await queryInterface.bulkInsert('users', [{ id: 1, defaultTenantId: null }]);
    await queryInterface.bulkInsert('tenantUsers', [
      { userId: 1, tenantId: 'tenant-a' },
      { userId: 1, tenantId: 'tenant-b' },
    ]);
    await queryInterface.bulkInsert('attachments', [{ id: 1, createdById: 1, tenantId: null }]);

    const migration = new TenantFieldsMigration({ db: app.db } as MigrationContext);
    migration.context.app = app;

    await migration.up();

    const [rows] = (await app.db.sequelize.query('select id, tenantId from attachments order by id')) as any;
    expect(rows).toEqual([{ id: 1, tenantId: null }]);
  });
});

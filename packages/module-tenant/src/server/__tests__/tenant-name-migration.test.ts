import { createMockServer, type MockServer } from '@tachybase/test';
import { DataTypes, type MigrationContext } from '@tego/server';

import TenantNameMigration from '../migrations/20260821190000-use-tenant-name';

describe('tenant name migration', () => {
  let app: MockServer;

  beforeEach(async () => {
    app = await createMockServer();
  });

  afterEach(async () => {
    await app.destroy();
  });

  async function createLegacyTenantTable() {
    await app.db.sequelize.getQueryInterface().createTable('tenants', {
      id: { type: DataTypes.STRING, primaryKey: true },
      name: { type: DataTypes.STRING, allowNull: false, unique: true },
      title: { type: DataTypes.STRING, allowNull: true },
      parentId: { type: DataTypes.STRING, allowNull: true },
      path: { type: DataTypes.STRING, allowNull: true },
    });
  }

  function createMigration() {
    const migration = new TenantNameMigration({ db: app.db } as MigrationContext);
    migration.context.app = app;
    return migration;
  }

  it('should migrate display names into the unique name column and remove title', async () => {
    const queryInterface = app.db.sequelize.getQueryInterface();
    await createLegacyTenantTable();
    await queryInterface.bulkInsert('tenants', [
      { id: 'tenant-a', name: 'tenant_a', title: 'tenant_b' },
      { id: 'tenant-b', name: 'tenant_b', title: 'Tenant B' },
      { id: 'tenant-c', name: '__tenant_name_migration_0__', title: 'Tenant C' },
      { id: 'tenant-d', name: 'tenant_d', title: null },
    ]);

    const migration = createMigration();
    await migration.up();
    await migration.up();

    const table = await queryInterface.describeTable('tenants');
    const [rows] = (await app.db.sequelize.query('SELECT id, name FROM tenants ORDER BY id')) as any;

    expect(table.title).toBeUndefined();
    expect(rows).toEqual([
      { id: 'tenant-a', name: 'tenant_b' },
      { id: 'tenant-b', name: 'Tenant B' },
      { id: 'tenant-c', name: 'Tenant C' },
      { id: 'tenant-d', name: 'tenant_d' },
    ]);
  });

  it('should reject duplicate tenant names without changing legacy data', async () => {
    const queryInterface = app.db.sequelize.getQueryInterface();
    await createLegacyTenantTable();
    await queryInterface.bulkInsert('tenants', [
      { id: 'tenant-a', name: 'tenant_a', title: 'Duplicate' },
      { id: 'tenant-b', name: 'tenant_b', title: 'Duplicate' },
    ]);

    await expect(createMigration().up()).rejects.toThrow('Duplicate tenant names');

    const table = await queryInterface.describeTable('tenants');
    const [rows] = (await app.db.sequelize.query('SELECT id, name, title FROM tenants ORDER BY id')) as any;

    expect(table.title).toBeDefined();
    expect(rows).toEqual([
      { id: 'tenant-a', name: 'tenant_a', title: 'Duplicate' },
      { id: 'tenant-b', name: 'tenant_b', title: 'Duplicate' },
    ]);
  });

  it('should report case-insensitive duplicate tenant names without changing legacy data', async () => {
    const queryInterface = app.db.sequelize.getQueryInterface();
    await createLegacyTenantTable();
    await app.db.sequelize.query('CREATE UNIQUE INDEX tenants_name_nocase ON tenants (name COLLATE NOCASE)');
    await queryInterface.bulkInsert('tenants', [
      { id: 'tenant-a', name: 'tenant_a', title: 'Acme' },
      { id: 'tenant-b', name: 'tenant_b', title: 'ACME' },
    ]);

    await expect(createMigration().up()).rejects.toThrow('Duplicate tenant names');

    const table = await queryInterface.describeTable('tenants');
    const [rows] = (await app.db.sequelize.query('SELECT id, name, title FROM tenants ORDER BY id')) as any;

    expect(table.title).toBeDefined();
    expect(rows).toEqual([
      { id: 'tenant-a', name: 'tenant_a', title: 'Acme' },
      { id: 'tenant-b', name: 'tenant_b', title: 'ACME' },
    ]);
  });

  it('should preserve tenant hierarchy indexes when removing title', async () => {
    const queryInterface = app.db.sequelize.getQueryInterface();
    await createLegacyTenantTable();
    await queryInterface.addIndex('tenants', ['parentId'], { name: 'tenants_parent_id' });
    await queryInterface.addIndex('tenants', ['path'], { name: 'tenants_path' });
    await queryInterface.bulkInsert('tenants', [{ id: 'tenant-a', name: 'tenant_a', title: 'Tenant A' }]);

    await createMigration().up();

    const indexNames = (await queryInterface.showIndex('tenants')).map((index) => index.name);
    expect(indexNames).toEqual(expect.arrayContaining(['tenants_parent_id', 'tenants_path']));
  });

  it('should restore title values when rolled back', async () => {
    const queryInterface = app.db.sequelize.getQueryInterface();
    await createLegacyTenantTable();
    await queryInterface.bulkInsert('tenants', [{ id: 'tenant-a', name: 'tenant_a', title: 'Tenant A' }]);

    const migration = createMigration();
    await migration.up();
    await migration.down();
    await migration.down();

    const table = await queryInterface.describeTable('tenants');
    const [rows] = (await app.db.sequelize.query('SELECT id, name, title FROM tenants ORDER BY id')) as any;

    expect(table.title).toBeDefined();
    expect(rows).toEqual([{ id: 'tenant-a', name: 'Tenant A', title: 'Tenant A' }]);
  });
});

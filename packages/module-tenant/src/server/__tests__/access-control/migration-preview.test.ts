import { ACL, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey } from '../../access-control/config-store';
import { AccessMigrationPreviewService } from '../../access-control/migration-preview';
import { grantStoredScope, seedAclScopes } from './acl-database';
import { configStore, externalIdentity, initialConfig, mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const legacy = { tenancy: 'tenantScoped', legacyDataTenantIds: ['B'], allowEditingLegacyData: true };

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('table migration preview (%s)', (dialect) => {
  let db: Database;
  let acl: ACL;
  let collection: Collection;
  let scopes: AccessAclScopeAdapter;
  let service: AccessMigrationPreviewService;

  const key = (value: Collection) =>
    accessCollectionKey({ ...mainIdentity, collectionKey: value.options.key, collectionName: value.name });
  const preview = () => service.preview(mainIdentity, [{ role: 'member', action: 'list' }]);
  const updateMetadata = (values: Record<string, unknown>) =>
    db.getRepository('collections').update({ filterByTk: 'documents', values });

  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl) : sqliteDatabase();
    collection = db.collection({
      name: 'documents',
      key: mainIdentity.collectionKey,
      timestamps: false,
      autoGenId: false,
      ...structuredClone(legacy),
      fields: [
        { name: 'id', type: 'bigInt', primaryKey: true, autoIncrement: true },
        { name: 'tenantId', type: 'string' },
        { name: 'name', type: 'string' },
      ],
    });
    await seedConfigStore(db);
    await updateMetadata(legacy);
    await seedAclScopes(db);
    acl = new ACL();
    await grantStoredScope(db, acl);
    scopes = new AccessAclScopeAdapter(acl, 'main', configStore(db), db);
    service = new AccessMigrationPreviewService(db, {
      dataSourceKey: 'main',
      db,
      scopes,
      resolveCollectionKey: key,
    });
  });

  afterEach(async () => {
    try {
      if (dialect === 'postgres')
        await db.sequelize.query(
          'DROP TABLE IF EXISTS "rolesResourcesScopesActions", "dataSourcesRolesResourcesScopesActions", ' +
            '"rolesResourcesScopes", "dataSourcesRolesResourcesScopes", "documents", ' +
            '"access_config_collections", "access_config_dataSourcesCollections", "tenantAccessRevisions"',
        );
    } finally {
      await db?.close();
    }
  });

  it('combines effective legacy settings, rule draft and explicit role scopes without writing or enabling', async () => {
    const writes = vi.spyOn(db.getRepository('collections'), 'update');
    const before = acl.getRole('member').getActionParams('documents:list');
    const report = await preview();
    expect(report).toMatchObject({
      identity: mainIdentity,
      legacy,
      draft: { schemaVersion: 1, revision: 0, ownership: { enabled: true } },
      roleScopes: [{ role: 'member', resource: 'documents', action: 'list', treatment: 'delegate-builtin-scope' }],
    });
    expect(report.draft.rules.map((rule) => rule.category)).toEqual(['ownership', 'visibility', 'ownership']);
    expect(writes).not.toHaveBeenCalled();
    expect(await configStore(db).read(mainIdentity)).toBeNull();
    expect(await db.getRepository('tenantAccessRevisions').count()).toBe(0);
    expect(acl.getRole('member').getActionParams('documents:list')).toEqual(before);
  });

  it.each(['shared', 'tenantScoped', 'tenantInherited'])(
    'uses the runtime %s mode and retains custom ACL restrictions',
    async (tenancy) => {
      collection.options.tenancy = tenancy;
      await updateMetadata({ tenancy });
      acl.getRole('member').grantAction('documents:view', { filter: { name: 'mine' }, fields: ['id'] });
      const report = await preview();
      expect(report.legacy.tenancy).toBe(tenancy);
      expect(report.draft.ownership.enabled).toBe(tenancy !== 'shared');
      expect(report.roleScopes[0]).toMatchObject({
        treatment: 'retain-role-scope',
        params: { filter: { name: 'mine' }, fields: ['id'] },
      });
    },
  );

  it('uses registered built-in settings when metadata has no override and supplies only legacy runtime defaults', async () => {
    await db.getCollection('collections').model.update({ options: {} }, { where: { key: mainIdentity.collectionKey } });
    delete collection.options.legacyDataTenantIds;
    delete collection.options.allowEditingLegacyData;
    expect((await preview()).legacy).toEqual({
      tenancy: 'tenantScoped',
      legacyDataTenantIds: [],
      allowEditingLegacyData: false,
    });
  });

  it.each([undefined, null, 'unknown'])('does not infer a shared mode from %j', async (tenancy) => {
    collection.options.tenancy = tenancy;
    await expect(preview()).rejects.toThrow();
  });

  it.each([{ tenancy: 'shared' }, { legacyDataTenantIds: ['C'] }, { allowEditingLegacyData: false }])(
    'rejects persisted settings that disagree with the running collection: %j',
    async (values) => {
      await updateMetadata(values);
      await expect(preview()).rejects.toMatchObject({ code: 'ACCESS_CONFIG_CONFLICT' });
    },
  );

  it('refuses to replace a table that already has a new configuration', async () => {
    await configStore(db).save(mainIdentity, initialConfig(), { userId: 28 });
    await expect(preview()).rejects.toMatchObject({ code: 'ACCESS_CONFIG_CONFLICT' });
    expect((await configStore(db).read(mainIdentity)).revision).toBe(1);
  });

  it('checks persistent collection identity even when the runtime name still exists', async () => {
    await expect(service.preview({ ...mainIdentity, collectionKey: 'old-key' }, [])).rejects.toThrow();
    await db.getRepository('collections').destroy({ filterByTk: 'documents' });
    await expect(preview()).rejects.toMatchObject({ code: 'ACCESS_COLLECTION_NOT_FOUND' });
  });

  it('refuses a runtime collection registered under a different persistent key', async () => {
    collection.options.key = 'replacement';
    await expect(preview()).rejects.toThrow();
  });

  it('reads same-named external metadata from the primary DB and runtime options from the external DB', async () => {
    const externalDb = sqliteDatabase();
    try {
      externalDb.collection({
        name: 'documents',
        key: externalIdentity.collectionKey,
        timestamps: false,
        tenancy: 'shared',
        fields: [{ name: 'name', type: 'string' }],
      });
      const externalKey = (value: Collection) =>
        accessCollectionKey({
          ...externalIdentity,
          collectionKey: value.options.key,
          collectionName: value.name,
        });
      const external = new AccessMigrationPreviewService(db, {
        dataSourceKey: 'external',
        db: externalDb,
        scopes: new AccessAclScopeAdapter(acl, 'external', configStore(db), db),
        resolveCollectionKey: externalKey,
      });
      const report = await external.preview(externalIdentity, [{ role: 'member', action: 'list' }]);
      expect(report.identity).toEqual(externalIdentity);
      expect(report.legacy.tenancy).toBe('shared');
      expect(report.draft.ownership.enabled).toBe(false);
      expect(report.roleScopes[0].treatment).toBe('retain-role-scope');
      await expect(service.preview(externalIdentity, [])).rejects.toThrow();
    } finally {
      await externalDb.close();
    }
  });

  it.each(['settings', 'key', 'field'])(
    'rejects runtime %s changes while persistent metadata is being read',
    async (change) => {
      const model = db.getCollection('collections').model;
      const findOne = model.findOne.bind(model);
      vi.spyOn(model, 'findOne').mockImplementationOnce(async (options) => {
        const result = await findOne(options);
        if (change === 'settings') collection.options.legacyDataTenantIds.push('C');
        else if (change === 'key') collection.options.key = 'recreated';
        else collection.model.rawAttributes.tenantId.field = 'changed';
        return result;
      });
      await expect(preview()).rejects.toThrow();
    },
  );

  it.each(['config', 'legacy', 'deleted'])(
    'refuses a stale preview after persisted %s changes during role inspection',
    async (change) => {
      const model = db.getCollection('dataSourcesRolesResourcesScopes').model;
      const findAll = model.findAll.bind(model);
      vi.spyOn(model, 'findAll').mockImplementationOnce(async (options) => {
        if (change === 'config') await configStore(db).save(mainIdentity, initialConfig(), { userId: 28 });
        else if (change === 'legacy') await updateMetadata({ legacyDataTenantIds: ['C'] });
        else await db.getRepository('collections').destroy({ filterByTk: 'documents' });
        return findAll(options);
      });
      await expect(preview()).rejects.toThrow();
    },
  );

  it('rechecks role grants after the final persistent metadata query', async () => {
    const model = db.getCollection('collections').model;
    const findOne = model.findOne.bind(model);
    let queries = 0;
    vi.spyOn(model, 'findOne').mockImplementation(async (options) => {
      const record = await findOne(options);
      if (++queries === 2) acl.getRole('member').grantAction('documents:view', { filter: { name: 'changed' } });
      return record;
    });
    await expect(preview()).rejects.toMatchObject({ code: 'ACCESS_CONFIG_CONFLICT' });
  });

  it('returns detached values and keeps request identity and role selection fixed before awaiting', async () => {
    const identity = { ...mainIdentity };
    const selections = [{ role: 'member', action: 'list' }];
    const pending = service.preview(identity, selections);
    identity.collectionKey = 'forged';
    selections[0].role = 'forged';
    const report = await pending;
    expect(report.identity).toEqual(mainIdentity);
    expect(report.roleScopes[0].role).toBe('member');
    report.legacy.legacyDataTenantIds.push('C');
    report.draft.rules[0].enabled = false;
    report.roleScopes[0].params.fields.push('private');
    const next = await preview();
    expect(next.legacy).toEqual(legacy);
    expect(next.draft.rules[0].enabled).toBe(true);
    expect(next.roleScopes[0].params.fields).toEqual(['id', 'name']);
  });

  it('allows unrelated metadata changes without changing the migration inputs', async () => {
    const model = db.getCollection('dataSourcesRolesResourcesScopes').model;
    const findAll = model.findAll.bind(model);
    vi.spyOn(model, 'findAll').mockImplementationOnce(async (options) => {
      await updateMetadata({ title: 'Renamed title' });
      return findAll(options);
    });
    expect((await preview()).legacy).toEqual(legacy);
  });

  it('does not advertise missing/strategy grants as permission and accepts an explicitly empty selection', async () => {
    acl.getRole('member').setStrategy({ actions: ['create'] });
    const report = await service.preview(mainIdentity, [
      { role: 'member', action: 'create' },
      { role: 'missing', action: 'list' },
    ]);
    expect(report.roleScopes.map((item) => item.treatment)).toEqual([
      'no-direct-resource-grant',
      'no-direct-resource-grant',
    ]);
    expect((await service.preview(mainIdentity, [])).roleScopes).toEqual([]);
  });

  it.each(['property', 'list'])('rejects a legacy %s accessor without invoking it', async (kind) => {
    const getter = vi.fn(() => 'B');
    if (kind === 'property') Object.defineProperty(collection.options, 'legacyDataTenantIds', { get: getter });
    else Object.defineProperty(collection.options.legacyDataTenantIds, '0', { get: getter });
    await expect(preview()).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([null, { schemaVersion: 999 }])(
    'refuses any existing new configuration, including %j',
    async (tenantAccess) => {
      await updateMetadata({ tenantAccess });
      await expect(preview()).rejects.toMatchObject({ code: 'ACCESS_CONFIG_CONFLICT' });
    },
  );

  it('rejects a runtime migration that has not reached persistent metadata', async () => {
    collection.options.tenantAccess = initialConfig();
    await expect(preview()).rejects.toMatchObject({ code: 'ACCESS_CONFIG_CONFLICT' });
  });

  it('captures role grants before the first asynchronous metadata query', async () => {
    const model = db.getCollection('collections').model;
    const findOne = model.findOne.bind(model);
    vi.spyOn(model, 'findOne').mockImplementationOnce(async (options) => {
      acl.getRole('member').grantAction('documents:view', { filter: { name: 'changed' } });
      return findOne(options);
    });
    await expect(preview()).rejects.toMatchObject({ code: 'ACCESS_CONFIG_CONFLICT' });
  });

  it('rechecks runtime legacy settings after asynchronous role inspection', async () => {
    const model = db.getCollection('dataSourcesRolesResourcesScopes').model;
    const findAll = model.findAll.bind(model);
    vi.spyOn(model, 'findAll').mockImplementationOnce(async (options) => {
      collection.options.legacyDataTenantIds.push('C');
      return findAll(options);
    });
    await expect(preview()).rejects.toMatchObject({ code: 'ACCESS_CONFIG_CONFLICT' });
  });

  it('uses the primary connection for both metadata checks', async () => {
    const queries = vi.spyOn(db.getCollection('collections').model, 'findOne');
    await preview();
    expect(queries).toHaveBeenCalledTimes(2);
    expect(queries.mock.calls.every(([options]) => options.useMaster === true)).toBe(true);
  });

  it('propagates a scope read failure instead of returning a partial report', async () => {
    const failure = new Error('Scope connection unavailable');
    vi.spyOn(db.getCollection('dataSourcesRolesResourcesScopes').model, 'findAll').mockRejectedValueOnce(failure);
    await expect(preview()).rejects.toBe(failure);
  });
});

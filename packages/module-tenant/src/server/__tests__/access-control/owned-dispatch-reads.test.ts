import { ACL, literal, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { AccessReadGrantAdapter, type AccessEntryReadPermission } from '../../access-control/read-grants';
import { AccessReadService, type AccessRootReadConstraint } from '../../access-control/reads';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('ownership-dispatched read pages (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let store: AccessConfigStore;
  let prepared: AccessAclScopeAdapter;
  let reads: AccessReadService;
  let permission: AccessEntryReadPermission;
  let constraint: AccessRootReadConstraint | undefined;
  const phase = {};

  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    docs = db.collection({
      name: 'documents',
      fields: [
        { name: 'id', type: 'integer', primaryKey: true, field: 'record_id' },
        { name: 'tenantId', type: 'string', field: 'tenant_id' },
        { name: 'name', type: 'string' },
        { name: 'state', type: 'string' },
      ],
    });
    await docs.model.sync();
    await docs.model.bulkCreate([
      { id: 1, tenantId: 'H', name: 'Visible', state: 'ready' },
      { id: 2, tenantId: 'B', name: 'Owned', state: 'ready' },
      { id: 3, tenantId: 'C', name: 'Other', state: 'ready' },
      { id: 4, tenantId: 'B', name: 'Blocked', state: 'blocked' },
      { id: 5, tenantId: null, name: 'Legacy', state: 'ready' },
    ]);
    const tenants = db.collection({
      name: 'tenants',
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'enabled', type: 'boolean' },
      ],
    });
    await tenants.model.sync();
    await tenants.model.bulkCreate(['H', 'B', 'C'].map((id) => ({ id, enabled: true })));
    const key = () => accessCollectionKey(mainIdentity);
    store = new AccessConfigStore(db, () => resolveModelMetadata(docs, { resolveCollectionKey: key }));
    const config = configFor({
      type: 'all',
      children: [
        {
          type: 'compare',
          operator: 'eq',
          left: { type: 'field', path: 'state' },
          right: { type: 'literal', value: 'ready' },
        },
        {
          type: 'any',
          children: [
            ownerCondition,
            {
              type: 'compare',
              operator: 'eq',
              left: { type: 'field', path: 'tenantId' },
              right: { type: 'literal', value: 'H' },
            },
          ],
        },
      ],
    });
    config.rules.push({ ...configFor({ type: 'constant', value: true }, 'visibility').rules[0], id: 'visible' });
    await store.save(mainIdentity, { ...config, revision: 0 }, { userId: 28 });
    prepared = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    await prepared.prepare(phase, [mainIdentity]);
    permission = { allowed: true, params: { fields: ['id', 'name'] } };
    constraint = undefined;
    const grants = new AccessReadGrantAdapter(db, key);
    reads = new AccessReadService(
      db,
      prepared,
      new AccessQueryService(db, prepared, key),
      () => grants.capture(mainIdentity, permission),
      undefined,
      async () => constraint!,
    );
  });
  afterEach(async () => {
    prepared?.release(phase);
    vi.restoreAllMocks();
    try {
      if (dialect === 'postgres')
        await db.sequelize.query(
          'DROP TABLE IF EXISTS "documents", "tenants", "rolesResourcesScopesActions", "dataSourcesRolesResourcesScopesActions", "rolesResourcesScopes", "dataSourcesRolesResourcesScopes", "access_config_collections", "access_config_dataSourcesCollections", "tenantAccessRevisions"',
        );
    } finally {
      await db?.close();
    }
  });

  const request = () => ({ attributes: ['id', 'name'], sort: ['id'], limit: 100 });

  it.each([
    { tenantId: 'H', id: 1 },
    { tenantId: 'B', id: 2 },
    { tenantId: 'C', id: 3 },
  ])(
    'selects only actual $tenantId ownership intersected with G, even when V and G grant other owners',
    async ({ tenantId, id }) => {
      expect((await reads.list(phase, mainIdentity, { tenantId }, request())).map((row) => row.id)).toEqual([
        1, 2, 3, 4, 5,
      ]);
      const rows = await reads.listOwned(phase, mainIdentity, { tenantId }, request());
      expect(rows.map((row) => row.id)).toEqual([id]);
      expect(rows[0]).toEqual({ id, name: ['Visible', 'Owned', 'Other'][id - 1] });
      expect((await docs.model.findByPk(5))!.get('tenantId')).toBeNull();
    },
  );

  it('retains final ACL fields, role predicates and request predicates', async () => {
    await docs.model.create({ id: 6, tenantId: 'B', name: 'Other', state: 'ready' });
    permission = { allowed: true, params: { fields: ['id'], filter: { name: 'Owned' } } };
    const input = { ...request(), attributes: ['id'] };
    expect(await reads.listOwned(phase, mainIdentity, { tenantId: 'B' }, input)).toEqual([{ id: 2 }]);
    expect(await reads.listOwned(phase, mainIdentity, { tenantId: 'B' }, { ...input, filter: { id: 6 } })).toEqual([]);
    await expect(reads.listOwned(phase, mainIdentity, { tenantId: 'B' }, request())).rejects.toThrow();
  });

  it('paginates the ownership intersection in SQL rather than filtering a visible page', async () => {
    await docs.model.create({ id: 6, tenantId: 'B', name: 'Second', state: 'ready' });
    expect(await reads.listOwned(phase, mainIdentity, { tenantId: 'B' }, { ...request(), limit: 1 })).toEqual([
      { id: 2, name: 'Owned' },
    ]);
    expect(
      await reads.listOwned(phase, mainIdentity, { tenantId: 'B' }, { ...request(), limit: 1, offset: 1 }),
    ).toEqual([{ id: 6, name: 'Second' }]);
  });

  it('rejects an absent action grant before selecting business records', async () => {
    permission = { allowed: false, params: {} };
    const query = vi.spyOn(docs.model, 'findAll');
    await expect(reads.listOwned(phase, mainIdentity, { tenantId: 'B' }, request())).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('requires an active real tenant even when G is constant and has no tenant variable', async () => {
    prepared.release(phase);
    const current = (await store.read(mainIdentity))!;
    await store.save(
      mainIdentity,
      { ...configFor({ type: 'constant', value: true }), revision: current.revision },
      { userId: 28 },
    );
    await prepared.prepare(phase, [mainIdentity]);
    await db.getCollection('tenants').model.update({ enabled: false }, { where: { id: 'B' } });
    await expect(reads.listOwned(phase, mainIdentity, { tenantId: 'B' }, request())).rejects.toThrow(
      /disabled|missing/i,
    );
    await expect(reads.listOwned(phase, mainIdentity, {}, request())).rejects.toThrow();
  });

  it('requires explicit ownership configuration', async () => {
    prepared.release(phase);
    const current = (await store.read(mainIdentity))!;
    await store.save(
      mainIdentity,
      { ...configFor({ type: 'constant', value: true }), ownership: { enabled: false }, revision: current.revision },
      { userId: 28 },
    );
    await prepared.prepare(phase, [mainIdentity]);
    await expect(reads.listOwned(phase, mainIdentity, { tenantId: 'B' }, request())).rejects.toThrow(/ownership/i);
  });

  it('keeps trusted source constraints and reserves their SQL bindings', async () => {
    constraint = {
      where: literal('"documents"."record_id" <> $tac_scope0_owner'),
      bind: { tac_scope0_owner: 2 },
      assertCurrent: () => undefined,
    };
    expect(await reads.listOwned(phase, mainIdentity, { tenantId: 'B' }, request())).toEqual([]);
  });

  it('rejects a phase ended after the actual business query', async () => {
    const original = docs.model.findAll.bind(docs.model);
    vi.spyOn(docs.model, 'findAll').mockImplementation(async (...args) => {
      const rows = await original(...args);
      prepared.release(phase);
      return rows;
    });
    await expect(reads.listOwned(phase, mainIdentity, { tenantId: 'B' }, request())).rejects.toThrow(/phase|prepared/i);
  });
});

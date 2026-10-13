import type { Database } from '@tego/server';

import { AccessConfigError } from '../../access-control/config-errors';
import { registerAccessConfigGuards } from '../../access-control/config-store';
import { configStore, externalIdentity, initialConfig, mainIdentity, seedConfigStore } from './config-database';
import { sqliteDatabase } from './database';

describe('tenant access metadata mutation boundary', () => {
  let db: Database;
  let errorLog: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    db = sqliteDatabase();
    await seedConfigStore(db);
    registerAccessConfigGuards(db);
    errorLog = vi.spyOn(console, 'error').mockImplementation((error) => {
      if (!(error instanceof AccessConfigError)) throw error;
    });
  });
  afterEach(async () => {
    await db.close();
    errorLog.mockRestore();
  });

  it.each([
    ['collections', mainIdentity],
    ['dataSourcesCollections', externalIdentity],
  ] as const)('retains saved access rules during ordinary %s metadata updates', async (name, identity) => {
    const store = configStore(db);
    const config = await store.save(identity, initialConfig(), { userId: 28 });
    await db
      .getRepository(name)
      .update({ filter: { key: identity.collectionKey }, values: { options: { title: 'New title' } } });
    expect(await store.read(identity)).toEqual(config);
    expect((await db.getRepository(name).findOne({ filter: { key: identity.collectionKey } })).get('title')).toBe(
      'New title',
    );
    expect(await db.getRepository('tenantAccessRevisions').count()).toBe(1);
  });

  it.each([{ tenantAccess: initialConfig() }, { options: { tenantAccess: initialConfig() } }])(
    'rejects direct configuration writes through ordinary metadata updates',
    async (values) => {
      await expect(db.getRepository('collections').update({ filterByTk: 'documents', values })).rejects.toMatchObject({
        code: 'INVALID_ACCESS_CONFIG_WRITE',
      });
      expect(await configStore(db).read(mainIdentity)).toBeNull();
    },
  );

  it('rejects explicit null configuration rather than deleting the migration marker', async () => {
    const store = configStore(db);
    const config = await store.save(mainIdentity, initialConfig(), { userId: 28 });
    await expect(
      db.getRepository('collections').update({ filterByTk: 'documents', values: { tenantAccess: null } }),
    ).rejects.toThrow();
    expect(await store.read(mainIdentity)).toEqual(config);
  });

  it('prevents moving configured metadata to another data source', async () => {
    const store = configStore(db);
    const config = await store.save(externalIdentity, initialConfig(), { userId: 28 });
    await expect(
      db.getRepository('dataSourcesCollections').update({
        filter: { key: externalIdentity.collectionKey },
        values: { dataSourceKey: 'other' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_CONFIG_WRITE' });
    expect(await store.read(externalIdentity)).toEqual(config);
  });

  it('allows an unchanged configuration echoed by an ordinary metadata editor', async () => {
    const config = await configStore(db).save(mainIdentity, initialConfig(), { userId: 28 });
    await db
      .getRepository('collections')
      .update({ filterByTk: 'documents', values: { title: 'Updated', tenantAccess: config } });
    expect((await configStore(db).read(mainIdentity)).revision).toBe(1);
  });

  it('preserves latest rules when an earlier model instance saves unrelated options', async () => {
    const store = configStore(db);
    const first = await store.save(mainIdentity, initialConfig(), { userId: 28 });
    const stale = await db.getRepository('collections').findOne({ filterByTk: 'documents' });
    const second = await store.save(mainIdentity, { ...first, rules: [] }, { userId: 16 });
    await db.sequelize.transaction(async (transaction) => {
      await stale.update({ title: 'From stale instance' }, { transaction });
    });
    expect(await store.read(mainIdentity)).toEqual(second);
  });

  it('rejects bulk options replacement when per-record validation cannot run', async () => {
    await expect(
      db.getRepository('collections').update({
        filterByTk: 'documents',
        values: { options: { tenantAccess: initialConfig() } },
        individualHooks: false,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_CONFIG_WRITE' });
    expect(await configStore(db).read(mainIdentity)).toBeNull();
  });

  it('rejects copying new access configuration through metadata creation', async () => {
    await expect(
      db.getRepository('collections').create({
        values: { key: 'copied', name: 'copy', tenantAccess: initialConfig() },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_CONFIG_WRITE' });
  });

  it('rejects bulk creation and upsert paths that would skip individual configuration guards', async () => {
    const model = db.getCollection('collections').model;
    await expect(
      model.bulkCreate([{ key: 'copied', name: 'copy', options: { tenantAccess: initialConfig() } }]),
    ).rejects.toThrow();
    await expect(
      model.upsert({ key: mainIdentity.collectionKey, name: 'documents', options: { title: 'Overwritten' } }),
    ).rejects.toThrow();
  });

  it('rejects bulk update paths even when Sequelize requests individual hooks', async () => {
    await expect(
      db.getCollection('collections').model.update(
        { options: { tenantAccess: initialConfig() } },
        {
          where: { key: mainIdentity.collectionKey },
          individualHooks: true,
        },
      ),
    ).rejects.toThrow();
    expect(await configStore(db).read(mainIdentity)).toBeNull();
  });

  it('preserves configuration during a transactional bulk update with individual hooks', async () => {
    const store = configStore(db);
    const config = await store.save(mainIdentity, initialConfig(), { userId: 28 });
    await db.sequelize.transaction(async (transaction) => {
      await db.getCollection('collections').model.update(
        { options: { title: 'Bulk title' } },
        {
          where: { key: mainIdentity.collectionKey },
          individualHooks: true,
          transaction,
        },
      );
    });
    expect(await store.read(mainIdentity)).toEqual(config);
  });

  it('rejects bulk data source moves that bypass individual metadata validation', async () => {
    await configStore(db).save(externalIdentity, initialConfig(), { userId: 28 });
    await expect(
      db.getCollection('dataSourcesCollections').model.update(
        { dataSourceKey: 'other' },
        {
          where: { key: externalIdentity.collectionKey },
        },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_CONFIG_WRITE' });
  });

  it('rejects dot notation configuration changes through ordinary repository updates', async () => {
    await configStore(db).save(mainIdentity, initialConfig(), { userId: 28 });
    await expect(
      db.getRepository('collections').update({
        filterByTk: 'documents',
        values: { 'tenantAccess.revision': 20 },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_CONFIG_WRITE' });
  });

  it('cannot authorize configuration writes using caller-supplied flags', async () => {
    await expect(
      db.getRepository('collections').update({
        filterByTk: 'documents',
        values: { tenantAccess: initialConfig() },
        context: { accessConfigWrite: true, isAdmin: true },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_CONFIG_WRITE' });
  });

  it('rejects configuration changes made by direct model saves without a transaction', async () => {
    const record = await db.getRepository('collections').findOne({ filterByTk: 'documents' });
    await expect(record.update({ tenantAccess: initialConfig() })).rejects.toMatchObject({
      code: 'INVALID_ACCESS_CONFIG_WRITE',
    });
  });

  it('keeps audit revisions immutable through ordinary repository writes', async () => {
    await configStore(db).save(mainIdentity, initialConfig(), { userId: 28 });
    const repo = db.getRepository('tenantAccessRevisions');
    const history = await repo.findOne();
    await expect(repo.update({ filterByTk: history.get('id'), values: { actorUserId: '16' } })).rejects.toThrow();
    await expect(repo.destroy(history.get('id'))).rejects.toThrow();
    await expect(repo.create({ values: { ...history.get(), id: undefined, revision: 2 } })).rejects.toThrow();
    await expect(
      db.getCollection('tenantAccessRevisions').model.bulkCreate([{ ...history.get(), id: undefined, revision: 3 }]),
    ).rejects.toThrow();
    expect(await repo.count()).toBe(1);
  });
});

import type { Database } from '@tego/server';

import { AccessConfigStore } from '../../access-control/config-store';
import { configStore, externalIdentity, initialConfig, mainIdentity, seedConfigStore } from './config-database';
import { sqliteDatabase } from './database';
import { documents } from './fixtures';

describe('tenant access configuration authority', () => {
  let db: Database;
  let store: AccessConfigStore;

  beforeEach(async () => {
    db = sqliteDatabase();
    await seedConfigStore(db);
    store = configStore(db);
  });
  afterEach(async () => {
    await db.close();
  });

  it('distinguishes an unconfigured collection from an explicit empty rule set', async () => {
    expect(await store.read(mainIdentity)).toBeNull();
    await store.save(mainIdentity, { ...initialConfig(), rules: [] }, { userId: 28 });
    expect(await store.read(mainIdentity)).toMatchObject({ revision: 1, rules: [] });
  });

  it('saves validated rules and audit history without losing other metadata options', async () => {
    const saved = await store.save(mainIdentity, initialConfig(), { userId: 28 });
    expect(saved.revision).toBe(1);
    const record = await db.getRepository('collections').findOne({ filter: { key: mainIdentity.collectionKey } });
    expect(record.get('options')).toEqual({ title: 'Documents', tenancy: 'tenantScoped', tenantAccess: saved });
    const history = await db.getRepository('tenantAccessRevisions').find();
    expect(history).toHaveLength(1);
    expect(history[0].get()).toMatchObject({
      dataSourceKey: 'main',
      collectionKey: mainIdentity.collectionKey,
      collectionName: 'documents',
      revision: 1,
      actorUserId: '28',
      previousConfig: null,
      config: saved,
    });
    expect(history[0].get('savedAt')).toBeInstanceOf(Date);
  });

  it('rejects stale edits and does not write a new audit revision', async () => {
    await store.save(mainIdentity, initialConfig(), { userId: 28 });
    await expect(store.save(mainIdentity, initialConfig(), { userId: 16 })).rejects.toMatchObject({
      code: 'ACCESS_CONFIG_CONFLICT',
      status: 409,
    });
    expect((await store.read(mainIdentity)).revision).toBe(1);
    expect(await db.getRepository('tenantAccessRevisions').count()).toBe(1);
  });

  it('validates the full rule tree before changing configuration or history', async () => {
    await expect(
      store.save(mainIdentity, { ...initialConfig(), rules: [{ id: 'invalid' }] }, { userId: 28 }),
    ).rejects.toThrow();
    expect(await store.read(mainIdentity)).toBeNull();
    expect(await db.getRepository('tenantAccessRevisions').count()).toBe(0);
  });

  it('never treats an explicitly invalid stored configuration as unconfigured', async () => {
    await db.getRepository('collections').update({ filterByTk: 'documents', values: { tenantAccess: null } });
    await expect(store.read(mainIdentity)).rejects.toMatchObject({ code: 'INVALID_ACCESS_RULE' });
    await expect(store.save(mainIdentity, initialConfig(), { userId: 28 })).rejects.toThrow();
  });

  it('does not take the runtime collection options as configuration authority', async () => {
    db.getCollection('collections').options.tenantAccess = initialConfig();
    expect(await store.read(mainIdentity)).toBeNull();
    const find = vi.spyOn(db.getCollection('collections').model, 'findOne');
    await store.read(mainIdentity);
    expect(find.mock.calls[0][0]).toMatchObject({ useMaster: true });
  });

  it('separates same-named collections by data source and stable metadata key', async () => {
    await store.save(mainIdentity, initialConfig(), { userId: 28 });
    expect(await store.read(externalIdentity)).toBeNull();
    await store.save(externalIdentity, { ...initialConfig(), rules: [] }, { userId: 16 });
    expect((await store.read(mainIdentity)).rules).toHaveLength(1);
    expect((await store.read(externalIdentity)).rules).toHaveLength(0);
    await expect(store.read({ ...externalIdentity, dataSourceKey: 'other' })).rejects.toThrow();
  });

  it('does not reuse a removed collection configuration for a recreated collection with the same name', async () => {
    await store.save(mainIdentity, initialConfig(), { userId: 28 });
    await db.getRepository('collections').destroy({ filterByTk: 'documents' });
    await db.getRepository('collections').create({ values: { key: 'new-key', name: 'documents' } });
    await expect(store.read(mainIdentity)).rejects.toMatchObject({ code: 'ACCESS_COLLECTION_NOT_FOUND' });
    expect(await store.read({ ...mainIdentity, collectionKey: 'new-key' })).toBeNull();
  });

  it('rejects mismatched server metadata instead of validating against a different collection', async () => {
    const wrongStore = new AccessConfigStore(db, () => documents);
    await expect(wrongStore.save(mainIdentity, initialConfig(), { userId: 28 })).rejects.toThrow(/identity/i);
  });

  it('rolls back configuration and history when an existing repository hook fails', async () => {
    db.on('collections.afterUpdateWithAssociations', () => {
      throw new Error('metadata hook failure');
    });
    await expect(store.save(mainIdentity, initialConfig(), { userId: 28 })).rejects.toThrow('metadata hook failure');
    expect(await store.read(mainIdentity)).toBeNull();
    expect(await db.getRepository('tenantAccessRevisions').count()).toBe(0);
  });

  it('rolls back configuration if audit persistence fails', async () => {
    db.on('tenantAccessRevisions.beforeCreate', () => {
      throw new Error('audit unavailable');
    });
    await expect(store.save(mainIdentity, initialConfig(), { userId: 28 })).rejects.toThrow('audit unavailable');
    expect(await store.read(mainIdentity)).toBeNull();
  });

  it('rolls back if another metadata hook changes the validated configuration before persistence', async () => {
    db.on('collections.beforeSave', (model) => {
      model.setDataValue('options', {
        ...model.getDataValue('options'),
        tenantAccess: { ...initialConfig(), rules: [] },
      });
    });
    await expect(store.save(mainIdentity, initialConfig(), { userId: 28 })).rejects.toMatchObject({
      code: 'INVALID_ACCESS_CONFIG_WRITE',
    });
    expect(await store.read(mainIdentity)).toBeNull();
    expect(await db.getRepository('tenantAccessRevisions').count()).toBe(0);
  });

  it('does not let an in-place hook mutation alter the validation baseline', async () => {
    db.on('collections.beforeSave', (model) => {
      model.getDataValue('options').tenantAccess.rules.length = 0;
    });
    await expect(store.save(mainIdentity, initialConfig(), { userId: 28 })).rejects.toThrow();
    expect(await store.read(mainIdentity)).toBeNull();
  });

  it('records a deliberate restoration as a new revision and retains all previous versions', async () => {
    const first = await store.save(mainIdentity, initialConfig(), { userId: 28 });
    const second = await store.save(mainIdentity, { ...first, rules: [] }, { userId: 16 });
    const restored = await store.save(mainIdentity, { ...first, revision: second.revision }, { userId: 28 });
    expect(restored).toEqual({ ...first, revision: 3 });
    const history = await db.getRepository('tenantAccessRevisions').find({ sort: ['revision'] });
    expect(history.map((row) => row.get('revision'))).toEqual([1, 2, 3]);
    expect(history[2].get('previousConfig')).toEqual(second);
  });

  it('keeps one immutable snapshot per request while new requests load newer revisions', async () => {
    const first = await store.save(mainIdentity, initialConfig(), { userId: 28 });
    const snapshot = store.snapshot();
    const reads = await Promise.all([snapshot.read(mainIdentity), snapshot.read({ ...mainIdentity })]);
    expect(reads[0]).toBe(reads[1]);
    expect(Object.isFrozen(reads[0].rules[0].condition)).toBe(true);
    expect(() => reads[0].rules.push(first.rules[0])).toThrow();
    await store.save(mainIdentity, { ...first, rules: [] }, { userId: 16 });
    expect((await snapshot.read(mainIdentity)).revision).toBe(1);
    expect((await store.snapshot().read(mainIdentity)).revision).toBe(2);
    expect((await configStore(db).read(mainIdentity)).revision).toBe(2);
  });

  it('does not mutate input configuration and returns immutable saved values', async () => {
    const input = initialConfig();
    const saved = await store.save(mainIdentity, input, { userId: 28 });
    expect(input.revision).toBe(0);
    expect(Object.isFrozen(saved)).toBe(true);
    input.rules[0].name = 'Changed only in caller';
    expect((await store.read(mainIdentity)).rules[0].name).toBe('Test rule');
  });

  it.each([undefined, '', NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects missing or invalid audit actor %s',
    async (userId) => {
      await expect(store.save(mainIdentity, initialConfig(), { userId })).rejects.toThrow();
      expect(await store.read(mainIdentity)).toBeNull();
    },
  );
});

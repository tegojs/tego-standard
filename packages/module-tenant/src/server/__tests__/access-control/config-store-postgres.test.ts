import type { Database } from '@tego/server';

import { AccessConfigError } from '../../access-control/config-errors';
import { registerAccessConfigGuards } from '../../access-control/config-store';
import { configStore, initialConfig, mainIdentity, registerConfigModels, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase } from './database';

const databaseUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('tenant access configuration PostgreSQL concurrency', () => {
  let first: Database;
  let second: Database;
  let errorLog: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    first = isolatedPostgresDatabase(databaseUrl);
    await seedConfigStore(first);
    second = isolatedPostgresDatabase(databaseUrl);
    registerConfigModels(second);
    registerAccessConfigGuards(first);
    registerAccessConfigGuards(second);
    errorLog = vi.spyOn(console, 'error').mockImplementation((error) => {
      if (!(error instanceof AccessConfigError)) throw error;
    });
  });
  afterEach(async () => {
    try {
      if (first) {
        await first.sequelize.query(
          'DROP TABLE IF EXISTS "access_config_collections", "access_config_dataSourcesCollections", "tenantAccessRevisions"',
        );
      }
    } finally {
      await Promise.all([first?.close(), second?.close()]);
      errorLog?.mockRestore();
    }
  });

  it('allows only one of two independent writers to save the same initial revision', async () => {
    const outcomes = await Promise.allSettled([
      configStore(first).save(mainIdentity, initialConfig(), { userId: 28 }),
      configStore(second).save(mainIdentity, { ...initialConfig(), rules: [] }, { userId: 16 }),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'ACCESS_CONFIG_CONFLICT', status: 409 } });
    expect(await first.getRepository('tenantAccessRevisions').count()).toBe(1);
    const current = await configStore(second).read(mainIdentity);
    expect(current.revision).toBe(1);
    expect((await first.getRepository('collections').findOne({ filterByTk: 'documents' })).get('title')).toBe(
      'Documents',
    );
  });

  it('allows only one edit of an existing revision and keeps the winning audit trail', async () => {
    const config = await configStore(first).save(mainIdentity, initialConfig(), { userId: 28 });
    const outcomes = await Promise.allSettled([
      configStore(first).save(mainIdentity, { ...config, rules: [] }, { userId: 28 }),
      configStore(second).save(mainIdentity, { ...config, ownership: { enabled: false } }, { userId: 16 }),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'ACCESS_CONFIG_CONFLICT' },
    });
    const history = await second.getRepository('tenantAccessRevisions').find({ sort: ['revision'] });
    expect(history).toHaveLength(2);
    expect(history[1].get('previousConfig')).toEqual(config);
    expect(history[1].get('config')).toEqual(await configStore(first).read(mainIdentity));
  });

  it('reads committed revisions across independent database instances without a shared cache', async () => {
    const writer = configStore(first);
    const reader = configStore(second);
    const original = await writer.save(mainIdentity, initialConfig(), { userId: 28 });
    const ongoingRequest = reader.snapshot();
    expect(await ongoingRequest.read(mainIdentity)).toEqual(original);
    const saved = await writer.save(mainIdentity, { ...original, rules: [] }, { userId: 16 });
    expect(await ongoingRequest.read(mainIdentity)).toEqual(original);
    expect(await reader.snapshot().read(mainIdentity)).toEqual(saved);
    expect(await configStore(first).read(mainIdentity)).toEqual(saved);
  });

  it('preserves the latest configuration when a stale metadata editor changes another option', async () => {
    const store = configStore(first);
    const original = await store.save(mainIdentity, initialConfig(), { userId: 28 });
    const stale = await second.getRepository('collections').findOne({ filterByTk: 'documents' });
    const latest = await store.save(mainIdentity, { ...original, rules: [] }, { userId: 16 });
    await second.sequelize.transaction(async (transaction) => {
      await stale.update({ title: 'Other administrator edit' }, { transaction });
    });
    expect(await store.read(mainIdentity)).toEqual(latest);
    const record = await first.getRepository('collections').findOne({ filterByTk: 'documents' });
    expect(record.get('title')).toBe('Other administrator edit');
    expect(record.get('tenancy')).toBe('tenantScoped');
  });

  it('never exposes an uncommitted configuration to another service', async () => {
    const store = configStore(first);
    let release: () => void;
    let reached: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    first.on('collections.afterUpdateWithAssociations', async () => {
      reached();
      await held;
    });
    const pending = store.save(mainIdentity, initialConfig(), { userId: 28 });
    try {
      await entered;
      expect(await configStore(second).read(mainIdentity)).toBeNull();
    } finally {
      release();
      await pending;
    }
    expect((await configStore(second).read(mainIdentity)).revision).toBe(1);
  });
});

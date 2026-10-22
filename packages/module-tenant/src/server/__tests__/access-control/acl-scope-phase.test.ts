import { ACL, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { configStore, initialConfig, mainIdentity, seedConfigStore } from './config-database';
import { sqliteDatabase } from './database';

describe('owned access preparation phases', () => {
  let db: Database;
  let adapter: AccessAclScopeAdapter;
  let store: ReturnType<typeof configStore>;
  beforeEach(async () => {
    db = sqliteDatabase();
    await seedConfigStore(db);
    store = configStore(db);
    await store.save(mainIdentity, initialConfig(), { userId: 28 });
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
  });
  afterEach(async () => {
    await db.close();
  });

  it('keeps a phase only during its callback and returns the callback result', async () => {
    const ctx = {};
    const value = await adapter.withPrepared(ctx, [mainIdentity], () => {
      expect(adapter.configuration(ctx, mainIdentity)?.revision).toBe(1);
      return 42;
    });
    expect(value).toBe(42);
    expect(() => adapter.configuration(ctx, mainIdentity)).toThrow();
  });

  it('releases its phase after asynchronous work', async () => {
    const ctx = {};
    await adapter.withPrepared(ctx, [mainIdentity], async () => {
      await Promise.resolve();
      expect(adapter.configuration(ctx, mainIdentity)).not.toBeNull();
    });
    expect(() => adapter.configuration(ctx, mainIdentity)).toThrow();
  });

  it('preserves callback errors and still releases the phase', async () => {
    const ctx = {};
    const error = new Error('business failure');
    await expect(
      adapter.withPrepared(ctx, [mainIdentity], async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(() => adapter.configuration(ctx, mainIdentity)).toThrow();
  });

  it('does not release a phase already owned by another operation', async () => {
    const ctx = {};
    await adapter.prepare(ctx, [mainIdentity]);
    const existing = adapter.configuration(ctx, mainIdentity);
    await expect(adapter.withPrepared(ctx, [mainIdentity], () => 42)).rejects.toThrow(/already prepared/i);
    expect(adapter.configuration(ctx, mainIdentity)).toBe(existing);
  });

  it('does not publish a result after its phase has been released', async () => {
    const ctx = {};
    await expect(
      adapter.withPrepared(ctx, [mainIdentity], () => {
        adapter.release(ctx);
        return 42;
      }),
    ).rejects.toThrow(/phase.*ended/i);
  });

  it('does not enter a late preparation callback or release a replacement phase', async () => {
    const ctx = {};
    let resume!: () => void;
    const blocked = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const read = store.read.bind(store);
    const pending = vi.spyOn(store, 'read').mockImplementation(async (identity) => {
      await blocked;
      return read(identity);
    });
    const old = adapter.withPrepared(ctx, [mainIdentity], () => {
      throw new Error('late callback was entered');
    });
    const rejected = expect(old).rejects.toThrow(/phase.*ended/i);
    adapter.release(ctx);
    pending.mockRestore();
    let replacement;
    try {
      await adapter.prepare(ctx, [mainIdentity]);
      replacement = adapter.configuration(ctx, mainIdentity);
    } finally {
      resume();
    }
    await rejected;
    expect(adapter.configuration(ctx, mainIdentity)).toBe(replacement);
  });

  it.each([false, true])('rejects a replaced phase without releasing its replacement: throw=%s', async (fail) => {
    const ctx = {};
    let replacement;
    const error = new Error('original callback failure');
    const result = adapter.withPrepared(ctx, [mainIdentity], async () => {
      adapter.release(ctx);
      await adapter.prepare(ctx, [mainIdentity]);
      replacement = adapter.configuration(ctx, mainIdentity);
      if (fail) throw error;
      return 42;
    });
    if (fail) await expect(result).rejects.toBe(error);
    else await expect(result).rejects.toThrow(/phase.*ended|phase.*changed/i);
    expect(adapter.configuration(ctx, mainIdentity)).toBe(replacement);
  });
});

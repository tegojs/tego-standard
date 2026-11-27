import { AsyncLocalStorage } from 'node:async_hooks';
import type { Database } from '@tego/server';

/** Use Sequelize's actual CLS routing without replacing queries, pools or transactions. */
export async function withAmbientTransactions(db: Database, work: () => Promise<void>) {
  const storage = new AsyncLocalStorage<Map<string, unknown>>();
  const namespace = {
    get: (key: string) => storage.getStore()?.get(key),
    set: (key: string, value: unknown) => storage.getStore()!.set(key, value),
    run: (callback: () => unknown) => storage.run(new Map(), callback),
    bind: (callback: (...args: unknown[]) => unknown) => {
      const context = storage.getStore();
      return (...args: unknown[]) => storage.run(context ?? new Map(), () => callback(...args));
    },
  };
  const orm = db.sequelize.constructor as unknown as {
    useCLS: (value: typeof namespace) => void;
    _cls?: unknown;
  };
  const previous = Object.getOwnPropertyDescriptor(orm, '_cls');
  orm.useCLS(namespace);
  try {
    await work();
  } finally {
    if (previous) Object.defineProperty(orm, '_cls', previous);
    else delete orm._cls;
    storage.disable();
  }
}

import { createMockServer } from '@tachybase/test';

import PluginAuditLogs from '..';
import { auditLogsTestPlugin } from './helpers';

it('waits for an already dispatched audit batch before allowing database shutdown', async () => {
  const app = await createMockServer({ plugins: [auditLogsTestPlugin()] });
  const plugin = app.pm.get('audit-logs') as PluginAuditLogs;
  const model = app.db.getCollection('auditLogs').model;
  const original = model.bulkCreate.bind(model);
  let release!: () => void;
  let reached!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (reached = resolve));
  const insert = vi.spyOn(model, 'bulkCreate').mockImplementation(async (...args) => {
    reached();
    await hold;
    return original(...args);
  });
  let shutdown: Promise<unknown> | undefined;
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await plugin.handleSyncMessage({ type: 'auditLog', values: { type: 'create', collectionName: 'shutdownProbe' } });
    await vi.advanceTimersByTimeAsync(500);
    await started;
    let finished = false;
    shutdown = app.emitAsync('beforeDestroy').then(() => {
      finished = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    release();
    await shutdown;
    expect(await model.count({ where: { collectionName: 'shutdownProbe' } })).toBe(1);
  } finally {
    release();
    await shutdown;
    insert.mockRestore();
    vi.useRealTimers();
    await app.destroy();
  }
});

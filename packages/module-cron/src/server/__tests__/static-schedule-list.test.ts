import { describe, expect, it, vi } from 'vitest';

import { StaticScheduleTrigger } from '../service/StaticScheduleTrigger';

describe('cron list next scheduled time', () => {
  it.each([true, false])('supports paginate=%s without changing the response shape', async (paginate) => {
    let middleware;
    const service = new StaticScheduleTrigger();
    Object.assign(service, {
      app: { on: vi.fn(), resourcer: { use: (handler) => (middleware = handler) } },
      db: { on: vi.fn() },
    });
    await service.load();
    const start = new Date(Date.now() + 60_000);
    const rows = [
      { id: 1, enabled: true, startsOn: start },
      { id: 2, enabled: false, startsOn: start },
    ];
    const body = paginate ? { rows, count: 2 } : rows;
    const ctx = { action: { resourceName: 'cronJobs', actionName: 'list' }, body: undefined };

    await middleware(ctx, async () => {
      ctx.body = body;
    });

    expect(ctx.body).toBe(body);
    expect(rows[0]).toHaveProperty('nextTime', new Date(Math.floor(new Date(start).getTime() / 1000) * 1000));
    expect(rows[1]).not.toHaveProperty('nextTime');
  });
});

import { Gateway, Registry } from '@tego/server';

import { EventSourceQueueWorker } from '../queue/EventSourceQueueWorker';
import { PluginWebhook } from '../webhooks/Plugin';

describe('webhook list effects', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createMiddleware() {
    const use = vi.fn();
    vi.spyOn(Gateway, 'getInstance').mockReturnValue({ wsServer: {} } as any);
    vi.spyOn(EventSourceQueueWorker.prototype, 'start').mockImplementation(() => {});
    const plugin = {
      app: {
        resourcer: { define: vi.fn(), use },
        acl: { allow: vi.fn(), registerSnippet: vi.fn() },
        on: vi.fn(),
      },
      db: { sync: vi.fn() },
      triggers: new Registry(),
      changed: true,
      loadEventSources: vi.fn(),
    };
    await PluginWebhook.prototype.load.call(plugin);
    const [middleware] = use.mock.calls.find(([, options]) => options.tag === 'webhooks-show-effect');
    return { middleware, plugin };
  }

  it.each([true, false])('adds trigger effects with pagination=%s', async (paginate) => {
    const { middleware, plugin } = await createMiddleware();
    plugin.triggers.register('test', { getEffect: (model) => model.id === 1 });
    const rows: { id: number; type: string; effect?: boolean }[] = [
      { id: 1, type: 'test' },
      { id: 2, type: 'test' },
      { id: 3, type: 'unknown' },
    ];
    const body = paginate ? { rows, count: 3 } : rows;
    const ctx = { action: { resourceName: 'webhooks', actionName: 'list' }, body: undefined };

    await middleware(ctx, async () => {
      ctx.body = body;
    });

    expect(ctx.body).toBe(body);
    expect(rows.map((row) => row.effect)).toEqual([true, false, true]);
    expect(ctx.body.changed).toBe(true);
    if (paginate) {
      expect(ctx.body.count).toBe(3);
    }
  });

  it('supports an empty unpaginated list', async () => {
    const { middleware } = await createMiddleware();
    const ctx = { action: { resourceName: 'webhooks', actionName: 'list' }, body: [] };

    await middleware(ctx, async () => {});

    expect(ctx.body).toHaveLength(0);
  });
});

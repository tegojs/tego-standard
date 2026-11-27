import StaticScheduleTrigger from '../../../triggers/ScheduleTrigger/StaticScheduleTrigger';

describe('static schedule timer delivery', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('requeues a callback that fires before the occurrence is due', () => {
    const due = 10_000;
    let now = due - 10;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const callbacks: Array<() => void> = [];
    const scheduleTimeout = vi.fn((callback: () => void) => {
      callbacks.push(callback);
      return callbacks.length as unknown as NodeJS.Timeout;
    });
    vi.stubGlobal('setTimeout', scheduleTimeout);

    const plugin = { app: { on: vi.fn() }, getLogger: vi.fn() } as any;
    const scheduler = new StaticScheduleTrigger(plugin);
    const workflow = { id: 1 } as any;
    const dispatch = vi.spyOn(scheduler, 'trigger').mockResolvedValue();

    scheduler.schedule(workflow, due);
    expect(scheduleTimeout).toHaveBeenCalledTimes(1);

    now = due - 1;
    callbacks[0]();

    expect(dispatch).not.toHaveBeenCalled();
    expect(scheduleTimeout).toHaveBeenCalledTimes(2);

    now = due;
    callbacks[1]();
    expect(dispatch).toHaveBeenCalledWith(workflow, due);
  });
});

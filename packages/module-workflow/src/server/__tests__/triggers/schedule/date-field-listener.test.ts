import { vi } from 'vitest';

import DateFieldScheduleTrigger from '../../../triggers/ScheduleTrigger/DateFieldScheduleTrigger';

describe('DateFieldScheduleTrigger listener lifecycle', () => {
  it('should remove the listener registered by on()', () => {
    const db = {
      on: vi.fn(),
      off: vi.fn(),
    };
    const collectionManager = {
      db,
      getCollection: vi.fn().mockReturnValue({
        options: {},
      }),
    };
    const workflowPlugin = {
      app: {
        on: vi.fn(),
        dataSourceManager: {
          dataSources: new Map([
            [
              'main',
              {
                collectionManager,
              },
            ],
          ]),
        },
      },
    } as any;
    const trigger = new DateFieldScheduleTrigger(workflowPlugin);
    vi.spyOn(trigger, 'inspect').mockImplementation(() => undefined);
    const workflow = {
      id: 42,
      config: {
        collection: 'posts',
      },
    } as any;

    trigger.on(workflow);
    trigger.off(workflow);

    expect(db.on).toHaveBeenCalledTimes(1);
    expect(db.off).toHaveBeenCalledTimes(1);
    expect(db.off).toHaveBeenCalledWith('posts.afterSaveWithAssociations', db.on.mock.calls[0][1]);
  });

  it('should register the save listener before inspecting existing records', () => {
    const calls: string[] = [];
    const db = {
      on: vi.fn(() => calls.push('on')),
      off: vi.fn(),
    };
    const collectionManager = {
      db,
      getCollection: vi.fn().mockReturnValue({
        options: {},
      }),
    };
    const workflowPlugin = {
      app: {
        on: vi.fn(),
        dataSourceManager: {
          dataSources: new Map([
            [
              'main',
              {
                collectionManager,
              },
            ],
          ]),
        },
      },
    } as any;
    const trigger = new DateFieldScheduleTrigger(workflowPlugin);
    vi.spyOn(trigger, 'inspect').mockImplementation(() => {
      calls.push('inspect');
    });
    const workflow = {
      id: 42,
      config: {
        collection: 'posts',
      },
    } as any;

    trigger.on(workflow);

    expect(calls).toEqual(['on', 'inspect']);
  });
});

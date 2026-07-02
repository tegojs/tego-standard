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

  it('should pass the active transaction to immediate workflow trigger calls', async () => {
    const transaction = { id: 'tx-1' };
    const record = {
      get: vi.fn((key: string) => (key === 'id' ? 7 : undefined)),
    };
    const data = {
      get: vi.fn((key: string) => (key === 'id' ? 7 : undefined)),
      toJSON: vi.fn(() => ({ id: 7 })),
    };
    const repository = {
      findOne: vi.fn().mockResolvedValue(data),
    };
    const collectionManager = {
      getCollection: vi.fn().mockReturnValue({
        options: {},
        repository,
        filterTargetKey: 'id',
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
      trigger: vi.fn(),
    } as any;
    const trigger = new DateFieldScheduleTrigger(workflowPlugin);
    const workflow = {
      id: 42,
      config: {
        collection: 'posts',
      },
    } as any;

    await trigger.trigger(workflow, record, Date.now(), { transaction } as any);

    expect(repository.findOne).toHaveBeenCalledWith(expect.objectContaining({ transaction }));
    expect(workflowPlugin.trigger).toHaveBeenCalledWith(
      workflow,
      expect.any(Object),
      expect.objectContaining({ transaction }),
    );
  });

  it('should preserve numeric zero tenant ids when loading records to schedule', async () => {
    const record = {
      get: vi.fn((key: string) => {
        if (key === 'tenantId') {
          return 0;
        }
        return undefined;
      }),
      tenantId: 0,
    };
    const tenant = {
      get: vi.fn((key: string) => (key === 'id' ? 0 : undefined)),
      toJSON: vi.fn(() => ({ id: 0 })),
    };
    const tenantRepo = {
      find: vi.fn().mockResolvedValue([tenant]),
    };
    const db = {
      getCollection: vi.fn().mockReturnValue({
        options: { tenancy: 'tenantScoped' },
        model: {
          findAll: vi.fn().mockResolvedValue([record]),
        },
      }),
      getRepository: vi.fn((name: string) => (name === 'tenants' ? tenantRepo : undefined)),
      options: {
        dialect: 'sqlite',
      },
    };
    const workflowPlugin = {
      app: {
        on: vi.fn(),
        db,
      },
    } as any;
    const trigger = new DateFieldScheduleTrigger(workflowPlugin);

    const records = await trigger.loadRecordsToSchedule(
      {
        allExecuted: 0,
        config: {
          collection: 'posts',
          startsOn: { field: 'startsAt' },
        },
      } as any,
      new Date(),
    );

    expect(tenantRepo.find).toHaveBeenCalledWith({
      filter: {
        id: [0],
        enabled: true,
      },
    });
    expect(records).toHaveLength(1);
  });
});

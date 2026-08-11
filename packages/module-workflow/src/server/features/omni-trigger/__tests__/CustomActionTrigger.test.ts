import { OmniTrigger } from '../CustomActionTrigger';

describe('workflow > omni trigger > custom action tenant context', () => {
  function createTrigger(options: { workflowRecord?: any; repository?: any; workflowRepo?: any } = {}) {
    const repository = options.repository || {
      find: vi.fn(),
      findOne: vi.fn(),
    };
    const workflowRecord =
      options.workflowRecord ||
      ({
        key: 'wf-key',
        type: OmniTrigger.TYPE,
        sync: false,
        config: {
          collection: 'posts',
        },
      } as any);
    const workflowRepo = options.workflowRepo || {
      find: vi.fn().mockResolvedValue([workflowRecord]),
    };
    const errorHandlerPlugin = {
      errorHandler: {
        register: vi.fn(),
      },
    };
    const workflow = {
      app: {
        pm: {
          get: vi.fn().mockReturnValue(errorHandlerPlugin),
        },
        resourcer: {
          registerActionHandler: vi.fn(),
          use: vi.fn(),
        },
        acl: {
          allow: vi.fn(),
        },
      },
      db: {
        getCollection: vi.fn().mockReturnValue({
          model: {
            build: vi.fn().mockReturnValue({
              desensitize: () => ({ id: 1 }),
            }),
          },
        }),
        getRepository: vi.fn().mockReturnValue(workflowRepo),
      },
      enabledCache: new Map([[workflowRecord.id || 1, workflowRecord]]),
      trigger: vi.fn(),
    };
    const trigger = new OmniTrigger(workflow as any);

    return { repository, trigger, workflow, workflowRecord, workflowRepo };
  }

  function createContext(repository, actionParams: Record<string, any>, collectionOptions: Record<string, any> = {}) {
    const collection = {
      model: {
        primaryKeyAttribute: 'id',
      },
      options: collectionOptions,
      repository,
    };

    return {
      action: {
        params: actionParams,
      },
      body: null,
      get: vi.fn((name: string) => {
        if (name.toLowerCase() === 'x-data-source') {
          return undefined;
        }
        return undefined;
      }),
      state: {
        currentUser: { id: 1 },
        currentRole: 'member',
        currentTenantId: 'tenant-a',
      },
      tego: {
        dataSourceManager: {
          dataSources: {
            get: vi.fn().mockReturnValue({
              collectionManager: {
                getCollection: vi.fn().mockReturnValue(collection),
              },
            }),
          },
        },
      },
    };
  }

  it('triggerAction should pass http context to payload findOne and async workflow trigger', async () => {
    const { repository, trigger, workflow, workflowRecord } = createTrigger();
    repository.findOne.mockResolvedValue({ id: 1, title: 'stored' });
    const ctx = createContext(repository, {
      actionName: 'trigger',
      resourceName: 'posts',
      filterByTk: 1,
      values: { title: 'form' },
      triggerWorkflows: workflowRecord.key,
    });
    const next = vi.fn();

    await trigger.triggerAction(ctx as any, next);

    expect(repository.findOne).toHaveBeenCalledWith({
      filterByTk: 1,
      appends: [],
      context: ctx,
    });
    expect(workflow.trigger).toHaveBeenCalledWith(workflowRecord, expect.any(Object), { httpContext: ctx });
    expect(next).toHaveBeenCalled();
  });

  it('trigger should pass http context to workflow resource payload findOne and async workflow trigger', async () => {
    const workflowRecord = {
      key: 'wf-key',
      type: OmniTrigger.TYPE,
      sync: false,
      config: {
        collection: 'posts',
        appends: ['comments'],
      },
    };
    const { repository, trigger, workflow } = createTrigger({ workflowRecord });
    repository.findOne.mockResolvedValue({ id: 1, title: 'stored' });
    const ctx = createContext(repository, {
      values: { id: 1 },
    });
    ctx.action.resourceName = 'workflows';

    await (trigger as any).trigger(ctx, workflowRecord.key);

    expect(repository.findOne).toHaveBeenCalledWith({
      filterByTk: 1,
      appends: ['comments'],
      context: ctx,
    });
    expect(workflow.trigger).toHaveBeenCalledWith(workflowRecord, expect.any(Object), { httpContext: ctx });
  });

  it('triggerAction should apply tenant filter to tenant-scoped filterByTk lookup', async () => {
    const { repository, trigger, workflowRecord } = createTrigger();
    repository.findOne.mockResolvedValue(null);
    const ctx = createContext(
      repository,
      {
        actionName: 'trigger',
        resourceName: 'posts',
        filterByTk: 1,
        values: { title: 'form' },
        triggerWorkflows: workflowRecord.key,
      },
      { tenancy: 'tenantScoped' },
    );
    const next = vi.fn();

    await trigger.triggerAction(ctx as any, next);

    expect(repository.findOne).toHaveBeenCalledWith({
      filterByTk: 1,
      filter: { tenantId: 'tenant-a' },
      appends: [],
      context: ctx,
    });
  });

  it('triggerAction should strip user tenant filter and apply current tenant to filter lookup', async () => {
    const { repository, trigger, workflowRecord } = createTrigger();
    repository.find.mockResolvedValue([]);
    const ctx = createContext(
      repository,
      {
        actionName: 'trigger',
        resourceName: 'posts',
        filter: { tenantId: 'tenant-b', title: 'form' },
        values: { title: 'form' },
        triggerWorkflows: workflowRecord.key,
      },
      { tenancy: 'tenantScoped' },
    );
    const next = vi.fn();

    await trigger.triggerAction(ctx as any, next);

    expect(repository.find).toHaveBeenCalledWith({
      filter: {
        $and: [{ title: 'form' }, { tenantId: 'tenant-a' }],
      },
      appends: [],
      context: ctx,
    });
  });

  it('triggerAction should skip workflow execution when array lookup returns no records', async () => {
    const { repository, trigger, workflow, workflowRecord } = createTrigger();
    repository.find.mockResolvedValue([]);
    const ctx = createContext(repository, {
      actionName: 'trigger',
      resourceName: 'posts',
      filterByTk: [1, 2],
      values: { title: 'form' },
      triggerWorkflows: workflowRecord.key,
    });
    const next = vi.fn();

    await trigger.triggerAction(ctx as any, next);

    expect(workflow.trigger).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('triggerAction should merge form data into each record from filterByTk array lookup', async () => {
    const { repository, trigger, workflow, workflowRecord } = createTrigger();
    repository.find.mockResolvedValue([
      { id: 1, title: 'stored-1' },
      { id: 2, title: 'stored-2' },
    ]);
    const ctx = createContext(repository, {
      actionName: 'trigger',
      resourceName: 'posts',
      filterByTk: [1, 2],
      values: { status: 'submitted' },
      triggerWorkflows: workflowRecord.key,
    });
    const next = vi.fn();

    await trigger.triggerAction(ctx as any, next);

    expect(workflow.trigger).toHaveBeenCalledWith(
      workflowRecord,
      expect.objectContaining({
        data: [
          { id: 1, title: 'stored-1', status: 'submitted' },
          { id: 2, title: 'stored-2', status: 'submitted' },
        ],
      }),
      { httpContext: ctx },
    );
  });

  it('triggerAction should merge form data into each record from filter lookup', async () => {
    const { repository, trigger, workflow, workflowRecord } = createTrigger();
    repository.find.mockResolvedValue([
      { id: 1, title: 'stored-1' },
      { id: 2, title: 'stored-2' },
    ]);
    const ctx = createContext(repository, {
      actionName: 'trigger',
      resourceName: 'posts',
      filter: { status: 'draft' },
      values: { status: 'submitted' },
      triggerWorkflows: workflowRecord.key,
    });
    const next = vi.fn();

    await trigger.triggerAction(ctx as any, next);

    expect(workflow.trigger).toHaveBeenCalledWith(
      workflowRecord,
      expect.objectContaining({
        data: [
          { id: 1, title: 'stored-1', status: 'submitted' },
          { id: 2, title: 'stored-2', status: 'submitted' },
        ],
      }),
      { httpContext: ctx },
    );
  });

  it('trigger should apply tenant filter to workflow resource payload lookup', async () => {
    const workflowRecord = {
      key: 'wf-key',
      type: OmniTrigger.TYPE,
      sync: false,
      config: {
        collection: 'posts',
        appends: ['comments'],
      },
    };
    const { repository, trigger } = createTrigger({ workflowRecord });
    repository.findOne.mockResolvedValue({ id: 1, title: 'stored' });
    const ctx = createContext(
      repository,
      {
        values: { id: 1 },
      },
      { tenancy: 'tenantScoped' },
    );
    ctx.action.resourceName = 'workflows';

    await (trigger as any).trigger(ctx, workflowRecord.key);

    expect(repository.findOne).toHaveBeenCalledWith({
      filterByTk: 1,
      filter: { tenantId: 'tenant-a' },
      appends: ['comments'],
      context: ctx,
    });
  });
});

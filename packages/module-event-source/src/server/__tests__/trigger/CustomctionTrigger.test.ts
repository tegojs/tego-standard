import { EVENT_SOURCE_QUEUE_STATUS } from '../../constants';
import { EventSourceQueueWorker } from '../../queue/EventSourceQueueWorker';
import { ResourceEventTrigger } from '../../trigger/ResourceEventTrigger';
import { formatWorkflowError } from '../../utils/workflow-error';
import { WebhookController } from '../../webhooks/webhooks';

describe('event source workflow errors', () => {
  it('registers resource triggers after the tenant context is resolved', () => {
    const use = vi.fn();
    const trigger = new ResourceEventTrigger({ resourcer: { use } } as any);

    trigger.afterAllLoad();

    expect(use).toHaveBeenCalledWith(expect.any(Function), {
      tag: 'event-source-resource',
      after: 'setCurrentTenant',
    });
  });

  it('should preserve structured workflow error messages', () => {
    expect(formatWorkflowError({ message: 'SQL instruction execution failed' })).toBe(
      'SQL instruction execution failed',
    );
  });

  it('should serialize structured errors without falling back to object coercion', () => {
    expect(formatWorkflowError({ code: 'SQL_PERMISSION_DENIED' })).toBe('{"code":"SQL_PERMISSION_DENIED"}');
    expect(formatWorkflowError({ message: 'x', circular: undefined })).toBe('x');
  });

  it('should mark workflow calls with server-side event-source provenance', async () => {
    const triggerFromEventSource = vi.fn().mockResolvedValue(undefined);
    const context = {
      state: { currentUser: null, currentRole: 'AccountingSupervisor' },
      db: {
        getCollection: vi.fn().mockReturnValue({ model: {} }),
        getRepository: vi.fn().mockReturnValue({ findOne: vi.fn().mockResolvedValue({}) }),
      },
      tego: { getPlugin: vi.fn().mockReturnValue({ triggerFromEventSource }) },
    };

    await new WebhookController().triggerWorkflow(
      context as any,
      { workflowKey: 'settlement-recalculate', options: {} },
      {},
    );

    const [, triggerContext, triggerOptions] = triggerFromEventSource.mock.calls[0];
    expect(triggerContext).toEqual(expect.objectContaining({ data: {}, roleName: 'AccountingSupervisor' }));
    expect(triggerOptions).toEqual(expect.objectContaining({ httpContext: context }));
  });
});

describe('event source queue workflow failures', () => {
  it('should retry a synchronous workflow error instead of marking the queue job successful', async () => {
    const updates = [];
    const repository = {
      update: vi.fn(async (options) => updates.push(options.values)),
    };
    const app = {
      name: 'test-app',
      db: { getRepository: vi.fn().mockReturnValue(repository) },
      logger: { error: vi.fn() },
    };
    const triggerWorkflow = vi.spyOn(WebhookController.prototype, 'triggerWorkflow').mockResolvedValue({
      lastSavedJob: {
        get: (key: string) => (key === 'status' ? -1 : { message: 'SQL instruction execution failed' }),
      },
    } as any);

    await (new EventSourceQueueWorker(app as any) as any).processJob({
      id: 1,
      sourceId: 2,
      workflowKey: 'settlement-recalculate',
      payload: {},
      contextLite: {},
      attempt: 0,
      maxAttempts: 2,
      retryBackoffMs: 10,
    });

    expect(triggerWorkflow).toHaveBeenCalledOnce();
    expect(updates).toContainEqual(
      expect.objectContaining({
        status: EVENT_SOURCE_QUEUE_STATUS.FAILED,
        lastError: expect.stringContaining('SQL instruction execution failed'),
      }),
    );
    expect(updates).not.toContainEqual(expect.objectContaining({ status: EVENT_SOURCE_QUEUE_STATUS.SUCCESS }));
  });
});

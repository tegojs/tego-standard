import { describe, expect, it, vi } from 'vitest';

import { DatabaseEventTrigger } from '../../trigger/DatabaseEventTrigger';

describe('DatabaseEventTrigger', () => {
  const createTrigger = () => {
    const triggerFromEventSource = vi.fn().mockResolvedValue(undefined);
    const collection = { name: 'contract_plans' };
    const app = {
      db: {
        getRepository: vi.fn(() => ({
          findOne: vi.fn().mockResolvedValue({ key: 'workflow-key' }),
        })),
        modelCollection: {
          get: vi.fn(() => collection),
        },
      },
      logger: {
        error: vi.fn(),
      },
      pm: {
        get: vi.fn(() => ({ triggerFromEventSource })),
      },
    };
    const trigger = new DatabaseEventTrigger(app as any);
    const model = { constructor: class ContractPlan {} };

    return { model, trigger, triggerFromEventSource };
  };

  it('restores request association values removed before the database hook', async () => {
    const { model, trigger, triggerFromEventSource } = createTrigger();
    const requestBody = {
      lease_items: [{ id: 1 }],
      fee_items: [{ id: 2 }],
      tenantId: 'tenant-from-request',
    };
    const actionValues = {
      lease_items: requestBody.lease_items,
      tenantId: 'tenant-from-action',
    };
    const hookOptions = {
      values: { tenantId: 'tenant-a' },
      context: {
        request: { body: requestBody },
        action: {
          resourceName: 'contract_plans',
          params: { values: actionValues },
        },
      },
    };

    await trigger.getDbEvent({ code: '', workflowKey: 'workflow-key' } as any)(model, hookOptions);

    expect(triggerFromEventSource).toHaveBeenCalledWith(
      { key: 'workflow-key' },
      { data: '' },
      expect.objectContaining({
        dbOptions: expect.objectContaining({
          values: {
            ...requestBody,
            ...actionValues,
            tenantId: 'tenant-a',
          },
        }),
      }),
    );
    expect(hookOptions.values).toEqual({ tenantId: 'tenant-a' });
  });

  it('does not include request values from another resource', async () => {
    const { model, trigger, triggerFromEventSource } = createTrigger();
    const hookOptions = {
      values: { tenantId: 'tenant-a' },
      context: {
        action: {
          resourceName: 'other_collection',
          params: { values: { lease_items: [{ id: 1 }] } },
        },
      },
    };

    await trigger.getDbEvent({ code: '', workflowKey: 'workflow-key' } as any)(model, hookOptions);

    expect(triggerFromEventSource).toHaveBeenCalledWith(
      { key: 'workflow-key' },
      { data: '' },
      expect.objectContaining({
        dbOptions: hookOptions,
      }),
    );
  });
});

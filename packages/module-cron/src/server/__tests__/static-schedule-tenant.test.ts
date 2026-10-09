import { EXECUTION_STATUS, PluginWorkflow } from '@tachybase/module-workflow';

import { describe, expect, it, vi } from 'vitest';

import { StaticScheduleTrigger } from '../service/StaticScheduleTrigger';

function model(values: Record<string, any>) {
  return {
    ...values,
    get: (key: string) => values[key],
    toJSON: () => ({ ...values }),
  };
}

describe('cron static schedule tenant context', () => {
  it.each([
    { ready: true, sync: false, status: undefined, successful: true },
    { ready: false, sync: false, status: undefined, successful: false },
    { ready: true, sync: true, status: EXECUTION_STATUS.RESOLVED, successful: true },
    { ready: true, sync: true, status: EXECUTION_STATUS.ERROR, successful: false },
    { ready: true, sync: true, status: undefined, successful: false },
  ])(
    'counts accepted triggers with ready=$ready sync=$sync status=$status',
    async ({ ready, sync, status, successful }) => {
      const workflow = { id: 1, key: 'test-workflow', getNodes: vi.fn().mockResolvedValue([]) };
      const cronJob = model({ id: 3, workflowKey: workflow.key });
      Object.assign(cronJob, { increment: vi.fn(), update: vi.fn() });
      const plugin = Object.assign(Object.create(PluginWorkflow.prototype), {
        ready,
        events: [],
        eventsCount: 0,
        getLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn() }),
        isWorkflowSync: () => sync,
        triggerSync: vi.fn().mockResolvedValue(status === undefined ? null : { execution: { status } }),
        prepare: vi.fn(),
      });
      const service = new StaticScheduleTrigger();
      Object.assign(service, {
        app: { pm: { get: () => plugin } },
        db: {
          getRepository: (name) =>
            ({
              cronJobs: { findOne: vi.fn().mockResolvedValue(cronJob) },
              workflows: { findOne: vi.fn().mockResolvedValue(workflow) },
            })[name],
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        cronJobLock: { acquire: vi.fn().mockResolvedValue(true), release: vi.fn() },
      });

      await service.trigger(cronJob.id, Date.now());

      expect(cronJob.increment).toHaveBeenCalledWith(
        successful ? ['limitExecuted', 'allExecuted', 'successExecuted'] : ['limitExecuted', 'allExecuted'],
      );
      expect(plugin.events).toHaveLength(ready && !sync ? 1 : 0);
    },
  );

  it('triggers a tenant workflow once for each enabled tenant', async () => {
    const workflow = {
      key: 'tenant-workflow',
      getNodes: vi.fn().mockResolvedValue([{ config: { collection: 'contracts' } }]),
    };
    const cronJob = model({
      id: 1,
      workflowKey: workflow.key,
      repeat: null,
      limit: null,
      limitExecuted: 0,
    });
    Object.assign(cronJob, {
      increment: vi.fn(),
      update: vi.fn(),
    });
    const tenants = [
      model({ id: 'head-office', name: 'Head office', parentId: null, enabled: true }),
      model({ id: 'branch', name: 'Branch', parentId: 'head-office', enabled: true }),
      model({ id: 'disabled', name: 'Disabled', parentId: null, enabled: false }),
    ];
    const triggerWorkflow = vi.fn().mockResolvedValue({
      execution: { status: EXECUTION_STATUS.RESOLVED },
    });
    const repositories = {
      cronJobs: { findOne: vi.fn().mockResolvedValue(cronJob) },
      workflows: { findOne: vi.fn().mockResolvedValue(workflow) },
      tenants: { find: vi.fn().mockResolvedValue(tenants.filter((tenant) => tenant.enabled)) },
    };
    const service = new StaticScheduleTrigger();
    Object.assign(service as any, {
      app: {
        pm: {
          get: (plugin) =>
            plugin === PluginWorkflow ? { isReady: true, isWorkflowSync: () => true, trigger: triggerWorkflow } : null,
        },
        dataSourceManager: {
          dataSources: new Map([
            [
              'main',
              {
                collectionManager: {
                  getCollection: (name: string) =>
                    name === 'contracts'
                      ? { options: { tenancy: 'tenantInherited', legacyDataTenantIds: ['head-office'] } }
                      : null,
                },
              },
            ],
          ]),
        },
      },
      db: {
        getRepository: (name: keyof typeof repositories) => repositories[name],
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      cronJobLock: { acquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
    });

    await service.trigger(cronJob.id, Date.now());

    expect(repositories.tenants.find).toHaveBeenCalledWith({ filter: { enabled: true } });
    expect(triggerWorkflow).toHaveBeenCalledTimes(2);
    const states = Object.fromEntries(
      triggerWorkflow.mock.calls.map((call) => [call[2].context.state.currentTenantId, call[2].context.state]),
    );
    expect(Object.keys(states).sort()).toEqual(['branch', 'head-office']);
    expect(states['head-office']).toMatchObject({
      currentTenantDescendantIds: [],
      workflowExcludeLegacyData: false,
    });
    expect(states['branch']).toMatchObject({
      currentTenantDescendantIds: [],
      workflowExcludeLegacyData: true,
    });
  });

  it('triggers a workflow with shared collections only once without tenant context', async () => {
    const workflow = {
      key: 'shared-workflow',
      getNodes: vi.fn().mockResolvedValue([{ config: { collection: 'sharedContracts' } }]),
    };
    const cronJob = model({
      id: 2,
      workflowKey: workflow.key,
      repeat: null,
      limit: null,
      limitExecuted: 0,
    });
    Object.assign(cronJob, {
      increment: vi.fn(),
      update: vi.fn(),
    });
    const triggerWorkflow = vi.fn().mockResolvedValue({
      execution: { status: EXECUTION_STATUS.RESOLVED },
    });
    const service = new StaticScheduleTrigger();
    Object.assign(service as any, {
      app: {
        pm: {
          get: (plugin) =>
            plugin === PluginWorkflow ? { isReady: true, isWorkflowSync: () => true, trigger: triggerWorkflow } : null,
        },
        dataSourceManager: {
          dataSources: new Map([
            [
              'main',
              {
                collectionManager: {
                  getCollection: () => ({ options: {} }),
                },
              },
            ],
          ]),
        },
      },
      db: {
        getRepository: (name: string) =>
          ({
            cronJobs: { findOne: vi.fn().mockResolvedValue(cronJob) },
            workflows: { findOne: vi.fn().mockResolvedValue(workflow) },
          })[name],
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      cronJobLock: { acquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
    });

    await service.trigger(cronJob.id, Date.now());

    expect(triggerWorkflow).toHaveBeenCalledTimes(1);
    expect(triggerWorkflow.mock.calls[0][2].context).toBeNull();
  });
});

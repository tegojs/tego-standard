import { getApp } from '@tachybase/plugin-workflow-test';
import { MockServer } from '@tachybase/test';

import { EXECUTION_STATUS } from '../constants';
import { EVENT_SOURCE_EXECUTION_ORIGIN } from '../execution-provenance';
import { waitForFastAssertion, waitForWorkflowIdle } from './utils';

describe('workflow > subworkflow tenant context', () => {
  let app: MockServer;
  let plugin;
  let WorkflowModel;
  let repository;

  const collectionName = 'subworkflow_tenant_records';
  const tenantContext = {
    currentTenant: { id: 'tenant-a' },
    currentTenantId: 'tenant-a',
    currentTenantDescendantIds: ['tenant-child'],
    currentTenancyMode: 'tenantScoped',
    currentLegacyDataTenantIds: ['tenant-a'],
    workflowExcludeLegacyData: true,
  };
  const authContext = { currentRole: 'operator', currentUserId: 10 };

  beforeAll(async () => {
    app = await getApp();
    plugin = app.pm.get('workflow');
    WorkflowModel = app.db.getCollection('workflows').model;
    app.db.collection({
      name: collectionName,
      tenancy: 'tenantScoped',
      fields: [
        { name: 'title', type: 'string' },
        { name: 'tenantId', type: 'string' },
        { name: 'published', type: 'boolean', defaultValue: false },
      ],
    });
    await app.db.sync();
    repository = app.db.getRepository(collectionName);
  });

  beforeEach(async () => {
    await waitForWorkflowIdle(app);
    await WorkflowModel.update({ enabled: false }, { where: { enabled: true } });
    await repository.destroy({ filter: {} });
  });

  afterEach(() => waitForWorkflowIdle(app));
  afterAll(() => app.destroy());

  it.each([
    { sync: true, hasTenant: true },
    { sync: false, hasTenant: true },
    { sync: true, hasTenant: false },
    { sync: false, hasTenant: false },
  ])('restores persisted context: sync=$sync, hasTenant=$hasTenant', async ({ sync, hasTenant }) => {
    const ownRecord = await repository.create({ values: { title: 'target', tenantId: 'tenant-a' } });
    const otherRecord = await repository.create({ values: { title: 'target', tenantId: 'tenant-b' } });
    const child = await WorkflowModel.create({ enabled: true, type: 'asyncTrigger', sync });
    await child.createNode({
      type: 'update',
      config: {
        collection: collectionName,
        params: { filter: { title: 'target' }, values: { published: true } },
      },
    });
    const parent = await WorkflowModel.create({ enabled: true, type: 'asyncTrigger' });
    const triggerNode = await parent.createNode({
      type: 'trigger-instruction',
      config: {
        workflowKey: child.key,
        sourceArray: [{ sourcePath: '{{$context.data}}', keyName: 'data' }],
      },
    });

    // Queue only the persisted execution, just as a worker does after losing request options.
    const parentExecution = await parent.createExecution({
      key: parent.key,
      status: EXECUTION_STATUS.QUEUEING,
      context: { data: { tenantId: 'tenant-b' } },
      tenantContext: hasTenant ? tenantContext : null,
      authContext,
      executionOrigin: EVENT_SOURCE_EXECUTION_ORIGIN,
    });
    plugin.dispatch();
    await waitForFastAssertion(async () => {
      await parentExecution.reload();
      expect(parentExecution.status).not.toBe(EXECUTION_STATUS.QUEUEING);
      expect(parentExecution.status).not.toBe(EXECUTION_STATUS.STARTED);
    });
    await waitForWorkflowIdle(app);

    const [execution] = await child.getExecutions();
    expect(execution).toBeTruthy();
    expect(execution.tenantContext).toEqual(hasTenant ? tenantContext : null);
    expect(execution.tenantId).toBe(hasTenant ? 'tenant-a' : null);
    expect(execution.authContext).toEqual(authContext);
    expect(execution.executionOrigin).toBe(EVENT_SOURCE_EXECUTION_ORIGIN);
    expect(execution.context.data).toEqual({ tenantId: 'tenant-b' });
    expect(execution.status).toBe(hasTenant ? EXECUTION_STATUS.RESOLVED : EXECUTION_STATUS.ERROR);
    if (!sync) {
      expect(execution.parentId).toBe(parentExecution.id);
      expect(execution.parentNode).toBe(triggerNode.id);
    }
    await ownRecord.reload();
    await otherRecord.reload();
    expect(ownRecord.published).toBe(hasTenant);
    expect(otherRecord.published).toBe(false);
  });
});

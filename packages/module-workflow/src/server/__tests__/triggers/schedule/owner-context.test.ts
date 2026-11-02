import { createMockServer, type MockServer } from '@tachybase/test';

import { EXECUTION_STATUS } from '../../../constants';
import { waitForAssertion, waitForWorkflowIdle } from '../../utils';

describe('date-field schedules retain the record owner', () => {
  let app: MockServer;
  let workflow;

  beforeAll(async () => {
    app = await createMockServer({
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: ['error-handler', 'collection', 'user', 'workflow'],
    });
    app.db.collection({
      name: 'tenants',
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'enabled', type: 'boolean' },
        { name: 'path', type: 'string' },
      ],
    });
    for (const name of ['scheduledOwnerDocuments', 'scheduledOwnerResults']) {
      app.db.collection({
        name,
        tenancy: 'tenantInherited',
        fields: [
          { name: 'tenantId', type: 'string' },
          { name: 'name', type: 'string' },
        ],
      });
    }
    await app.db.sync();
  });

  beforeEach(async () => {
    await app.db.getCollection('tenants').model.destroy({ where: {}, hooks: false });
    await app.db.getCollection('tenants').model.bulkCreate([
      { id: 'B', enabled: true, path: '/B/' },
      { id: 'H', enabled: true, path: '/B/H/' },
    ]);
    for (const name of ['scheduledOwnerDocuments', 'scheduledOwnerResults'])
      await app.db.getCollection(name).model.destroy({ where: {}, hooks: false });
    workflow = await app.db.getRepository('workflows').create({
      values: {
        type: 'schedule',
        enabled: false,
        config: { mode: 1, collection: 'scheduledOwnerDocuments', startsOn: { field: 'createdAt' } },
      },
    });
    await workflow.createNode({
      type: 'create',
      config: { collection: 'scheduledOwnerResults', params: { values: { name: 'Generated' } } },
    });
    await workflow.update({ enabled: true });
  });

  afterEach(async () => {
    await workflow?.update({ enabled: false });
    await waitForWorkflowIdle(app);
  });
  afterAll(async () => {
    await app?.destroy();
  });

  const caller = {
    state: {
      currentTenantId: 'B',
      currentTenant: { id: 'B' },
      currentTenantDescendantIds: ['H'],
      currentTenancyMode: 'tenantInherited',
      currentRole: 'root',
      currentUser: { id: 99 },
    },
  };

  async function saveAsAncestor() {
    return app.db.getRepository('scheduledOwnerDocuments').create({
      values: { name: 'Child-owned document', tenantId: 'H' },
      context: caller,
    });
  }

  it.each(['tenantScoped', 'tenantInherited'])(
    'persists %s executions and generated data under the owner rather than the saving ancestor',
    async (tenancy) => {
      app.db.getCollection('scheduledOwnerDocuments').options.tenancy = tenancy;
      const record = await saveAsAncestor();
      await waitForAssertion(async () => {
        const [execution] = await workflow.getExecutions();
        expect(execution?.status).toBe(EXECUTION_STATUS.RESOLVED);
      });
      const [execution] = await workflow.getExecutions();
      expect(execution.context.data.id).toBe(record.get('id'));
      expect(execution.tenantId).toBe('H');
      expect(execution.tenantContext.currentTenantId).toBe('H');
      expect(execution.context.state.currentTenantId).toBe('H');
      expect(execution.get('authContext')).toBeNull();
      const generated = await app.db.getCollection('scheduledOwnerResults').model.findAll();
      expect(generated.map((row) => row.get('tenantId'))).toEqual(['H']);
      expect((await record.reload()).get('tenantId')).toBe('H');
      expect(caller.state.currentTenantId).toBe('B');
    },
  );

  it('does not dispatch a disabled owner through an enabled saving ancestor', async () => {
    await app.db.getCollection('tenants').model.update({ enabled: false }, { where: { id: 'H' } });
    const record = await saveAsAncestor();
    // Await the actual installed listener as well as draining the asynchronous workflow queue.
    await app.db.emitAsync('scheduledOwnerDocuments.afterSaveWithAssociations', record, { context: caller });
    await waitForWorkflowIdle(app);
    expect(await workflow.countExecutions()).toBe(0);
    expect(await app.db.getCollection('scheduledOwnerResults').model.count()).toBe(0);
  });
});

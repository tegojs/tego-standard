import { createMockServer, type MockServer } from '@tachybase/test';
import { ACL, Transaction, type Collection } from '@tego/server';

import { EXECUTION_STATUS, JOB_STATUS } from '../../../../../module-workflow/src/server/constants';
import type PluginWorkflow from '../../../../../module-workflow/src/server/Plugin';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessConfigHistory } from '../../access-control/config-history';
import {
  accessCollectionKey,
  AccessConfigStore,
  type AccessCollectionIdentity,
} from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { AccessWorkflowDestroyHandler } from '../../access-control/workflow-destroy-handler';
import { configFor, ownerCondition } from './fixtures';

/** Actual Plugin/Processor, isolated SQLite, fixture-supplied identity/grants and adequate transaction defaults. */
describe('unified ownership deletion in actual workflow executions', () => {
  let app: MockServer;
  let plugin: PluginWorkflow;
  let docs: Collection;
  let adapter: AccessAclScopeAdapter;
  let queries: AccessQueryService;
  let identity: AccessCollectionIdentity;
  let permission;
  let workflow;
  let failAfterDelete: boolean;

  beforeAll(async () => {
    app = await createMockServer({
      database: { dialect: 'sqlite', storage: ':memory:', transactionType: Transaction.TYPES.IMMEDIATE },
      plugins: [
        'error-handler',
        'collection',
        'user',
        [
          'workflow',
          {
            destroyResolver: () => async (request) => {
              await adapter.prepare(request.context, [identity]);
              try {
                const handler = new AccessWorkflowDestroyHandler(
                  app.db,
                  adapter,
                  queries,
                  () => identity,
                  (_target, operation) => {
                    expect(operation.authenticated).toEqual({ tenantId: 'B' });
                    return permission;
                  },
                );
                return await handler.handle(request, { tenantId: request.context.state.currentTenantId });
              } finally {
                adapter.release(request.context);
              }
            },
          },
        ],
      ],
    });
    plugin = app.pm.get('workflow') as PluginWorkflow;
    const record = await app.db.getRepository('collections').create({
      values: {
        name: 'accessDestroyDocuments',
        fields: [
          { name: 'name', type: 'string' },
          { name: 'amount', type: 'integer' },
          { name: 'tenantId', type: 'string' },
        ],
      },
      context: {},
    });
    docs = app.db.getCollection('accessDestroyDocuments');
    identity = { dataSourceKey: 'main', collectionKey: record.get('key'), collectionName: docs.name };
    await docs.model.sync();
    const tenants = app.db.collection({
      name: 'tenants',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'enabled', type: 'boolean' },
      ],
    });
    await tenants.model.sync();
    await tenants.model.bulkCreate(['B', 'C', 'H'].map((id) => ({ id, enabled: true })));
    await app.db.collection(accessConfigHistory).model.sync();
    const stableKey = () => accessCollectionKey(identity);
    const store = new AccessConfigStore(app.db, (target) =>
      resolveModelMetadata(app.db.getCollection(target.collectionName), { resolveCollectionKey: stableKey }),
    );
    const config = configFor(ownerCondition);
    config.rules.push({ ...configFor({ type: 'constant', value: true }, 'visibility').rules[0], id: 'visible' });
    await store.save(identity, { ...config, revision: 0 }, { userId: 28 });
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, app.db);
    queries = new AccessQueryService(app.db, adapter, stableKey);
    app.db.on('accessDestroyDocuments.afterDestroy', async (deleted) => {
      if (failAfterDelete && deleted.get('id') === 3) throw new Error('business hook rejected deletion');
    });
  });

  beforeEach(async () => {
    permission = { source: { ...identity }, actionName: 'destroy', allowed: true, params: {} };
    failAfterDelete = false;
    await docs.model.destroy({ where: {}, hooks: false });
    await docs.model.bulkCreate([
      { id: 1, name: 'Visible', tenantId: 'H', amount: 10 },
      { id: 2, name: 'Owned', tenantId: 'B', amount: 20 },
      { id: 3, name: 'Second', tenantId: 'B', amount: 30 },
      { id: 4, name: 'Other', tenantId: 'C', amount: 40 },
    ]);
    workflow = await app.db.getRepository('workflows').create({
      values: {
        title: 'Ownership delete execution',
        type: 'collection',
        sync: true,
        enabled: true,
        config: { collection: docs.name, mode: 1 },
      },
    });
  });
  afterEach(async () => {
    await workflow?.update({ enabled: false });
  });
  afterAll(async () => {
    await app?.destroy();
  });

  async function execute(params: object) {
    await workflow.createNode({ type: 'destroy', config: { collection: docs.name, params } });
    await plugin.trigger(
      workflow,
      { state: { currentTenantId: 'C' } },
      { context: { state: { currentTenantId: 'B' } } },
    );
    const [execution] = await workflow.getExecutions();
    const [job] = await execution.getJobs();
    const ids = (await docs.model.findAll({ order: [['id', 'ASC']] })).map((row) => row.get('id'));
    return { execution, job, ids };
  }

  it('persists only ownership-authorized deletions and their count with tenant-only execution identity', async () => {
    const { execution, job, ids } = await execute({ filter: {} });
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    expect(job.result).toBe(2);
    expect(ids).toEqual([1, 4]);
    expect(execution.get('tenantContext')).toMatchObject({ currentTenantId: 'B' });
    expect(execution.get('authContext')).toBeNull();
  });

  it('intersects final destroy conditions with the resolved node filter', async () => {
    permission.params = { filter: { amount: { $lt: 30 } } };
    const { execution, job, ids } = await execute({ filter: { amount: { $gte: 20 } } });
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result).toBe(1);
    expect(ids).toEqual([1, 3, 4]);
  });

  it('persists zero as a successful result when no owned record matches', async () => {
    const { execution, job, ids } = await execute({ filter: { id: 1 } });
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    expect(job.result).toBe(0);
    expect(ids).toEqual([1, 2, 3, 4]);
  });

  it('rejects a visible-only explicit target without falling back to old deletion', async () => {
    const { execution, job, ids } = await execute({ filterByTk: 1 });
    expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.status).toBe(JOB_STATUS.ERROR);
    expect(job.result.message).toBe('Record is unavailable for this mutation');
    expect(ids).toEqual([1, 2, 3, 4]);
  });

  it('does not delete or fall back when final destroy permission is denied', async () => {
    permission.allowed = false;
    const { execution, job, ids } = await execute({ filter: {} });
    expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.status).toBe(JOB_STATUS.ERROR);
    expect(job.result.message).toMatch(/not authorized/);
    expect(ids).toEqual([1, 2, 3, 4]);
  });

  it('rolls back earlier roots when a later business hook fails', async () => {
    failAfterDelete = true;
    const { execution, job, ids } = await execute({ filter: {} });
    expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.status).toBe(JOB_STATUS.ERROR);
    expect(job.result.message).toBe('business hook rejected deletion');
    expect(ids).toEqual([1, 2, 3, 4]);
  });
});

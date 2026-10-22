import { createMockServer, type MockServer } from '@tachybase/test';
import { ACL, Transaction } from '@tego/server';

import { EXECUTION_STATUS, JOB_STATUS } from '../../../../../module-workflow/src/server/constants';
import type { WorkflowDataOperationAuthority } from '../../../../../module-workflow/src/server/data-operation-authority';
import type WorkflowPlugin from '../../../../../module-workflow/src/server/Plugin';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessConfigHistory } from '../../access-control/config-history';
import {
  accessCollectionKey,
  AccessConfigStore,
  type AccessCollectionIdentity,
} from '../../access-control/config-store';
import { AccessEntryReadService } from '../../access-control/entry-reads';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { AccessWorkflowDestroyHandler } from '../../access-control/workflow-destroy-handler';
import { captureWorkflowAccessIdentity } from '../../access-control/workflow-identity';
import { AccessWorkflowQueryHandler } from '../../access-control/workflow-query-handler';
import { configFor, ownerCondition } from './fixtures';

/** Actual runtime proof supplies the configured root operation; G/V remains independently enforced. */
describe('workflow runtime authority with tenant data scopes', () => {
  let app: MockServer;
  let plugin: WorkflowPlugin;
  let adapter: AccessAclScopeAdapter;
  let queries: AccessQueryService;
  let source: AccessCollectionIdentity;
  let workflow;
  let captured: WorkflowDataOperationAuthority[];
  let failAfterDelete: boolean;
  const identity = (collection) => (collection.name === source.collectionName ? source : undefined);

  beforeAll(async () => {
    app = await createMockServer({
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: [
        'error-handler',
        'collection',
        'user',
        [
          'workflow',
          {
            queryResolver: () => async (request) => {
              const authority = plugin.captureDataOperationAuthority(request);
              const authenticated = captureWorkflowAccessIdentity(authority.context);
              captured.push(authority);
              await adapter.prepare(request.context, [source]);
              try {
                const reader = new AccessEntryReadService(app.db, adapter, queries, identity, (target, path) => {
                  authority.assertCurrent();
                  return {
                    allowed: authority.actionName === 'list' && target === authority.collection && path.length === 0,
                    params: {},
                  };
                });
                const result = await new AccessWorkflowQueryHandler(app.db, reader, identity).handle(
                  request,
                  authenticated,
                );
                authority.assertCurrent();
                return result;
              } finally {
                adapter.release(request.context);
              }
            },
            destroyTransactionOptions: () => ({ type: Transaction.TYPES.IMMEDIATE }),
            destroyResolver: () => async (request) => {
              const authority = plugin.captureDataOperationAuthority(request);
              const authenticated = captureWorkflowAccessIdentity(authority.context);
              captured.push(authority);
              await adapter.prepare(request.context, [source]);
              try {
                return await new AccessWorkflowDestroyHandler(app.db, adapter, queries, identity, (target) => {
                  authority.assertCurrent();
                  return {
                    source,
                    actionName: authority.actionName,
                    allowed: target === authority.collection,
                    params: {},
                  };
                }).handle(request, authenticated);
              } finally {
                adapter.release(request.context);
              }
            },
          },
        ],
      ],
    });
    plugin = app.pm.get('workflow') as WorkflowPlugin;
    const stored = await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: 'proofDocuments',
        fields: [
          { name: 'name', type: 'string' },
          { name: 'tenantId', type: 'string' },
        ],
      },
    });
    source = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName: 'proofDocuments' };
    await app.db.getCollection(source.collectionName).model.sync();
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
    const stableKey = () => accessCollectionKey(source);
    const store = new AccessConfigStore(app.db, (target) =>
      resolveModelMetadata(app.db.getCollection(target.collectionName), { resolveCollectionKey: stableKey }),
    );
    const config = configFor(ownerCondition);
    config.rules.push({
      ...configFor(
        {
          type: 'compare',
          operator: 'eq',
          left: { type: 'field', path: 'name' },
          right: { type: 'literal', value: 'Visible' },
        },
        'visibility',
      ).rules[0],
      id: 'visible',
    });
    await store.save(source, { ...config, revision: 0 }, { userId: 28 });
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, app.db);
    queries = new AccessQueryService(app.db, adapter, stableKey);
    app.db.on('proofDocuments.afterDestroy', (record) => {
      if (failAfterDelete && record.get('id') === 3) throw new Error('business deletion failed');
    });
  });
  beforeEach(async () => {
    captured = [];
    failAfterDelete = false;
    const model = app.db.getCollection(source.collectionName).model;
    await model.destroy({ where: {}, hooks: false });
    await model.bulkCreate([
      { id: 1, name: 'Owned', tenantId: 'B' },
      { id: 2, name: 'Visible', tenantId: 'H' },
      { id: 3, name: 'Second', tenantId: 'B' },
      { id: 4, name: 'Hidden', tenantId: 'C' },
    ]);
    workflow = await app.db.getRepository('workflows').create({
      values: {
        title: 'Runtime root operation with data scope',
        type: 'collection',
        sync: true,
        enabled: true,
        config: { collection: 'proofEvents', mode: 1 },
      },
    });
  });
  afterEach(async () => {
    await workflow?.update({ enabled: false });
  });
  afterAll(async () => {
    await app?.destroy();
  });

  async function execute(type: 'query' | 'destroy', params = {}, state: object = { currentTenantId: 'B' }) {
    await workflow.createNode({ type, config: { collection: source.collectionName, multiple: true, params } });
    await plugin.trigger(workflow, { state: { currentTenantId: 'H', currentRole: 'root' } }, { context: { state } });
    const [execution] = await workflow.getExecutions();
    const [job] = await execution.getJobs();
    return { execution, job };
  }
  async function ids() {
    return (await app.db.getCollection(source.collectionName).model.findAll({ order: [['id', 'ASC']] })).map((row) =>
      row.get('id'),
    );
  }

  it('uses the real list authority while independently limiting query results to G or V', async () => {
    const { execution, job } = await execute('query', { fields: ['name'], sort: [{ field: 'id' }] });
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result).toEqual([{ name: 'Owned' }, { name: 'Visible' }, { name: 'Second' }]);
    expect(execution.get('authContext')).toBeNull();
    expect(() => captured[0].assertCurrent()).toThrow(/authority/i);
  });
  it('uses real destroy authority without treating visibility as permission to delete', async () => {
    const { execution, job } = await execute('destroy');
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result).toBe(2);
    expect(await ids()).toEqual([2, 4]);
    expect(() => captured[0].assertCurrent()).toThrow(/authority/i);
  });
  it('rejects an explicit visibility-only deletion without falling back', async () => {
    const { execution, job } = await execute('destroy', { filterByTk: 2 });
    expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.status).toBe(JOB_STATUS.ERROR);
    expect(await ids()).toEqual([1, 2, 3, 4]);
  });
  it.each(['query', 'destroy'] as const)(
    'does not substitute event identity for missing rule context on %s',
    async (type) => {
      const { execution, job } = await execute(type, {}, {});
      expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
      expect(job.result.message).toMatch(/context|tenant/i);
      expect(await ids()).toEqual([1, 2, 3, 4]);
    },
  );
  it('rolls back earlier authorized deletions when a later business hook fails', async () => {
    failAfterDelete = true;
    const { execution, job } = await execute('destroy');
    expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.result.message).toBe('business deletion failed');
    expect(await ids()).toEqual([1, 2, 3, 4]);
    expect(() => captured[0].assertCurrent()).toThrow(/authority/i);
  });
});

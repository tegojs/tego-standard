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
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import type { AccessWorkflowDestroyRequest } from '../../access-control/workflow-destroy-handler';
import type { AccessWorkflowQueryRequest } from '../../access-control/workflow-query-handler';
import { AccessWorkflowRootHandler } from '../../access-control/workflow-root-handler';
import { configFor, ownerCondition } from './fixtures';

/** Actual runtime proof supplies the configured root operation; G/V remains independently enforced. */
describe('workflow runtime authority with tenant data scopes', () => {
  let app: MockServer;
  let plugin: WorkflowPlugin;
  let adapter: AccessAclScopeAdapter;
  let queries: AccessQueryService;
  let source: AccessCollectionIdentity;
  let store: AccessConfigStore;
  let handler: AccessWorkflowRootHandler;
  let lastRequest: AccessWorkflowQueryRequest | AccessWorkflowDestroyRequest;
  let queryAsDestroy: boolean;
  let cloneQuery: boolean;
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
              lastRequest = request;
              if (queryAsDestroy) return handler.destroy(request as unknown as AccessWorkflowDestroyRequest);
              return handler.query(cloneQuery ? { ...request } : request);
            },
            destroyTransactionOptions: () => ({ type: Transaction.TYPES.IMMEDIATE }),
            destroyResolver: () => async (request) => {
              lastRequest = request;
              return handler.destroy(request);
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
          { name: 'parent', type: 'belongsTo', target: 'proofDocuments', foreignKey: 'parentId' },
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
    store = new AccessConfigStore(app.db, (target) =>
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
    handler = new AccessWorkflowRootHandler(app.db, adapter, queries, identity, (request) => {
      const authority = plugin.captureDataOperationAuthority(request);
      captured.push(authority);
      return authority;
    });
    app.db.on('proofDocuments.afterDestroy', (record) => {
      if (failAfterDelete && record.get('id') === 3) throw new Error('business deletion failed');
    });
  });
  beforeEach(async () => {
    captured = [];
    cloneQuery = false;
    queryAsDestroy = false;
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
    vi.restoreAllMocks();
    await workflow?.update({ enabled: false });
  });
  afterAll(async () => {
    await app?.destroy();
  });

  async function execute(type: 'query' | 'destroy', params = {}, state: object = { currentTenantId: 'B' }) {
    await workflow.createNode({ type, config: { collection: source.collectionName, multiple: true, params } });
    return run(state);
  }
  async function run(state: object = { currentTenantId: 'B' }) {
    await plugin.trigger(workflow, { state: { currentTenantId: 'H', currentRole: 'root' } }, { context: { state } });
    const [execution] = await workflow.getExecutions({ order: [['id', 'DESC']] });
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
    expect(() => adapter.configuration(lastRequest.context, source)).toThrow();
  });
  it('uses real destroy authority without treating visibility as permission to delete', async () => {
    const { execution, job } = await execute('destroy');
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result).toBe(2);
    expect(await ids()).toEqual([2, 4]);
    expect(() => captured[0].assertCurrent()).toThrow(/authority/i);
    expect(() => adapter.configuration(lastRequest.context, source)).toThrow();
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
    expect(() => adapter.configuration(lastRequest.context, source)).toThrow();
  });

  it('rejects a copied executor request before reading configuration', async () => {
    cloneQuery = true;
    const read = vi.spyOn(store, 'read');
    const { execution, job } = await execute('query');
    expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.result.message).toMatch(/authority/i);
    expect(read).not.toHaveBeenCalled();
  });

  it('does not use a real list proof to authorize deletion', async () => {
    queryAsDestroy = true;
    const { execution, job } = await execute('query');
    expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.result.message).toMatch(/operation|authority/i);
    expect(await ids()).toEqual([1, 2, 3, 4]);
  });

  it.each(['query', 'destroy'] as const)(
    'requires explicit persisted configuration for %s and does not fall back',
    async (type) => {
      vi.spyOn(store, 'read').mockResolvedValue(null);
      const { execution, job } = await execute(type);
      expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
      expect(job.result.message).toMatch(/config/i);
      expect(await ids()).toEqual([1, 2, 3, 4]);
      expect(() => adapter.configuration(lastRequest.context, source)).toThrow();
    },
  );

  it('snapshots query parameters and canonical identity before configuration reads suspend', async () => {
    const read = store.read.bind(store);
    vi.spyOn(store, 'read').mockImplementation(async (identity) => {
      await Promise.resolve();
      const request = lastRequest as AccessWorkflowQueryRequest;
      (request.query as { filter: { name: string } }).filter.name = 'Hidden';
      (request.context as { state: { currentTenantId: string } }).state.currentTenantId = 'C';
      return read(identity);
    });
    const { execution, job } = await execute('query', { fields: ['name'], filter: { name: 'Owned' } });
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result).toEqual([{ name: 'Owned' }]);
  });

  it('snapshots deletion keys before configuration reads suspend', async () => {
    const read = store.read.bind(store);
    vi.spyOn(store, 'read').mockImplementation(async (identity) => {
      await Promise.resolve();
      ((lastRequest as AccessWorkflowDestroyRequest).params as { filterByTk: number[] }).filterByTk[0] = 3;
      return read(identity);
    });
    const { execution, job } = await execute('destroy', { filterByTk: [1] });
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result).toBe(1);
    expect(await ids()).toEqual([2, 3, 4]);
  });

  it('preserves configuration read errors and cleans up the failed preparation', async () => {
    vi.spyOn(store, 'read').mockRejectedValue(new Error('configuration storage failed'));
    const { execution, job } = await execute('query');
    expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.result.message).toBe('configuration storage failed');
    expect(() => adapter.configuration(lastRequest.context, source)).toThrow();
  });

  it.each([
    ['query', { fields: ['name'], sort: [{ field: 'parent.name' }] }],
    ['destroy', { filter: { parent: { name: 'Hidden' } } }],
  ] as const)('keeps unsupported relationship operations closed: %s', async (type, params) => {
    const { execution, job } = await execute(type, params);
    expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.result.message).toMatch(/association|relationship/i);
    expect(await ids()).toEqual([1, 2, 3, 4]);
    expect(() => adapter.configuration(lastRequest.context, source)).toThrow();
  });

  it('deduplicates configuration for a configured self association', async () => {
    const read = vi.spyOn(store, 'read');
    const { execution, job } = await execute('query', { fields: ['name', 'parent.name'], sort: [{ field: 'id' }] });
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result).toEqual([
      { name: 'Owned', parent: null },
      { name: 'Visible', parent: null },
      { name: 'Second', parent: null },
    ]);
    expect(read.mock.calls.map(([identity]) => identity.collectionName)).toEqual(['proofDocuments']);
  });

  it('reads fresh persisted rules for each execution instead of caching them on the handler', async () => {
    const original = (await store.read(source))!;
    const read = vi.spyOn(store, 'read');
    try {
      const before = await execute('query', { fields: ['name'], sort: [{ field: 'id' }] });
      expect(before.job.result).toEqual([{ name: 'Owned' }, { name: 'Visible' }, { name: 'Second' }]);
      await store.save(source, { ...original, rules: [original.rules[0]] }, { userId: 28 });
      const after = await run();
      expect(after.execution.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(after.job.result).toEqual([{ name: 'Owned' }, { name: 'Second' }]);
      expect(after.execution.id).not.toBe(before.execution.id);
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      vi.restoreAllMocks();
      const current = (await store.read(source))!;
      await store.save(source, { ...original, revision: current.revision }, { userId: 28 });
    }
  });

  it.each(['query', 'destroy'] as const)(
    'preserves identity-free automation for explicitly shared %s configuration',
    async (type) => {
      const original = (await store.read(source))!;
      try {
        await store.save(
          source,
          {
            ...configFor({ type: 'constant', value: true }, type === 'query' ? 'visibility' : 'ownership'),
            revision: original.revision,
          },
          { userId: 28 },
        );
        const params = type === 'query' ? { fields: ['name'], sort: [{ field: 'id' }] } : {};
        const { execution, job } = await execute(type, params, {});
        expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
        expect(job.result).toEqual(
          type === 'query' ? [{ name: 'Owned' }, { name: 'Visible' }, { name: 'Second' }, { name: 'Hidden' }] : 4,
        );
        if (type === 'destroy') expect(await ids()).toEqual([]);
      } finally {
        const current = (await store.read(source))!;
        await store.save(source, { ...original, revision: current.revision }, { userId: 28 });
      }
    },
  );

  it.each(['query', 'destroy'] as const)('does not grant identity-free %s access for empty rules', async (type) => {
    const original = (await store.read(source))!;
    try {
      await store.save(source, { ...original, ownership: { enabled: false }, rules: [] }, { userId: 28 });
      const { execution, job } = await execute(type, {}, {});
      expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(job.result).toEqual(type === 'query' ? [] : 0);
      expect(await ids()).toEqual([1, 2, 3, 4]);
    } finally {
      const current = (await store.read(source))!;
      await store.save(source, { ...original, revision: current.revision }, { userId: 28 });
    }
  });

  it('rejects a replaced query phase while preserving the replacement for its owner', async () => {
    let replacement;
    const resolve = queries.resolveScopes.bind(queries);
    vi.spyOn(queries, 'resolveScopes').mockImplementation(async (...args) => {
      if (!replacement) {
        adapter.release(lastRequest.context);
        await adapter.prepare(lastRequest.context, [source]);
        replacement = adapter.configuration(lastRequest.context, source);
      }
      return resolve(...args);
    });
    try {
      const { execution, job } = await execute('query', { fields: ['name'] });
      expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
      expect(job.result.message).toMatch(/phase|preparation/i);
      expect(replacement).toBeDefined();
      expect(adapter.configuration(lastRequest.context, source)).toBe(replacement);
    } finally {
      adapter.release(lastRequest.context);
    }
  });
});

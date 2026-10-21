import { createMockServer, type MockServer } from '@tachybase/test';
import { ACL, type Collection } from '@tego/server';

import { EXECUTION_STATUS, JOB_STATUS } from '../../../../../module-workflow/src/server/constants';
import type PluginWorkflow from '../../../../../module-workflow/src/server/Plugin';
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
import type { AccessEntryReadPermission } from '../../access-control/read-grants';
import { AccessWorkflowQueryHandler } from '../../access-control/workflow-query-handler';
import { configFor, ownerCondition } from './fixtures';

/** Real plugin/Processor and SQLite; execution identity and final permissions are server fixture inputs. */
describe('unified tenant queries in actual workflow executions', () => {
  let app: MockServer;
  let plugin: PluginWorkflow;
  let adapter: AccessAclScopeAdapter;
  let store: AccessConfigStore;
  let queries: AccessQueryService;
  let workflow;
  let permissions: Map<string, AccessEntryReadPermission>;
  const identities = new Map<string, AccessCollectionIdentity>();
  const identity = (collection: Collection) => identities.get(collection.name);
  const stableKey = (collection: Collection) => accessCollectionKey(identity(collection)!);

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
              await adapter.prepare(request.context, [...identities.values()]);
              try {
                // This is test-only composition, not a new production authentication or ACL evaluator.
                const state = request.context.state;
                const authenticated = {
                  tenantId: state.currentTenantId,
                  roleName: state.currentRole,
                  userId: state.currentUserId,
                };
                const reader = new AccessEntryReadService(
                  app.db,
                  adapter,
                  queries,
                  identity,
                  (_target, path) => permissions.get(path.join('.')) ?? { allowed: false, params: {} },
                );
                return await new AccessWorkflowQueryHandler(app.db, reader, identity).handle(request, authenticated);
              } finally {
                adapter.release(request.context);
              }
            },
          },
        ],
      ],
    });
    plugin = app.pm.get('workflow') as PluginWorkflow;
    const db = app.db;
    for (const name of ['accessWorkflowProjects', 'accessWorkflowDocuments']) {
      const record = await db.getRepository('collections').create({
        values: {
          name,
          fields: [
            { name: 'name', type: 'string' },
            { name: 'tenantId', type: 'string' },
            { name: 'amount', type: 'integer' },
            ...(name === 'accessWorkflowDocuments'
              ? [{ name: 'project', type: 'belongsTo', target: 'accessWorkflowProjects', foreignKey: 'projectId' }]
              : []),
          ],
        },
        context: {},
      });
      identities.set(name, { dataSourceKey: 'main', collectionName: name, collectionKey: record.get('key') });
      await db.getCollection(name).model.sync();
    }
    const tenants = db.collection({
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
    await db.collection(accessConfigHistory).model.sync();
    store = new AccessConfigStore(db, (target) =>
      resolveModelMetadata(db.getCollection(target.collectionName), { resolveCollectionKey: stableKey }),
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
    for (const target of identities.values()) await store.save(target, { ...config, revision: 0 }, { userId: 28 });
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    queries = new AccessQueryService(db, adapter, stableKey);
    await db.getCollection('accessWorkflowProjects').model.bulkCreate([
      { id: 101, name: 'Local project', tenantId: 'B' },
      { id: 102, name: 'Hidden project', tenantId: 'C' },
    ]);
    await db.getCollection('accessWorkflowDocuments').model.bulkCreate([
      { id: 1, name: 'Owned', amount: 10, tenantId: 'B', projectId: 101 },
      { id: 2, name: 'Visible', amount: 20, tenantId: 'H', projectId: 102 },
      { id: 3, name: 'Hidden', amount: 30, tenantId: 'C', projectId: 101 },
    ]);
  });

  beforeEach(async () => {
    permissions = new Map([
      ['', { allowed: true, params: { fields: ['id', 'name', 'amount'], appends: ['project'] } }],
      ['project', { allowed: true, params: { fields: ['name'] } }],
    ]);
    workflow = await app.db.getRepository('workflows').create({
      values: {
        title: 'Unified query execution',
        type: 'collection',
        sync: true,
        enabled: true,
        config: { collection: 'accessWorkflowDocuments', mode: 1 },
      },
    });
  });
  afterEach(async () => {
    await workflow?.update({ enabled: false });
  });
  afterAll(async () => {
    await app?.destroy();
  });

  const node = (config = {}, extra = {}) =>
    workflow.createNode({
      type: 'query',
      config: { collection: 'accessWorkflowDocuments', multiple: true, ...config },
      ...extra,
    });
  async function execute(tenantId: string | null = 'B', human = true) {
    await plugin.trigger(
      workflow,
      { state: { currentTenantId: 'C', currentRole: 'admin', currentUser: { id: 99 } } },
      {
        context: {
          state: {
            currentTenantId: tenantId,
            ...(human ? { currentRole: 'worker', currentUser: { id: 28 } } : {}),
          },
        },
      },
    );
    const [execution] = await workflow.getExecutions({ order: [['id', 'DESC']] });
    return { execution, jobs: await execution.getJobs({ order: [['id', 'ASC']] }) };
  }

  it('persists ownership and visibility results with independently filtered associations', async () => {
    await node({ params: { fields: ['name'], appends: ['project.name'], filter: { amount: { $lte: 20 } } } });
    const { execution, jobs } = await execute();
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(jobs[0].result).toEqual([
      { name: 'Owned', project: { name: 'Local project' } },
      { name: 'Visible', project: null },
    ]);
    expect(execution.get('tenantContext')).toMatchObject({ currentTenantId: 'B' });
    expect(execution.get('authContext')).toMatchObject({ currentRole: 'worker', currentUserId: 28 });
  });
  it('uses a fresh tenant context for each execution rather than the event payload', async () => {
    await node({ params: { fields: ['name'], sort: [{ field: 'id' }] } });
    expect((await execute()).jobs[0].result).toEqual([{ name: 'Owned' }, { name: 'Visible' }]);
    expect((await execute('C')).jobs[0].result).toEqual([{ name: 'Visible' }, { name: 'Hidden' }]);
  });
  it('runs an authorized automatic query with only a trusted tenant and independently scoped associations', async () => {
    await node({ params: { fields: ['name'], appends: ['project.name'], sort: [{ field: 'id' }] } });
    const { execution, jobs } = await execute('B', false);
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(jobs[0].result).toEqual([
      { name: 'Owned', project: { name: 'Local project' } },
      { name: 'Visible', project: null },
    ]);
    expect(execution.get('tenantContext')).toMatchObject({ currentTenantId: 'B' });
    expect(execution.get('authContext')).toBeNull();
  });
  it('does not require tenant or human identity for explicitly shared query rules', async () => {
    const target = identities.get('accessWorkflowDocuments')!;
    const original = (await store.read(target))!;
    try {
      await store.save(
        target,
        { ...configFor({ type: 'constant', value: true }), revision: original.revision },
        { userId: 28 },
      );
      await node({ params: { fields: ['name'] } });
      const { execution, jobs } = await execute(null, false);
      expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(jobs[0].result).toEqual([{ name: 'Owned' }, { name: 'Visible' }, { name: 'Hidden' }]);
      expect(execution.get('tenantContext')).toBeNull();
      expect(execution.get('authContext')).toBeNull();
    } finally {
      const current = (await store.read(target))!;
      await store.save(target, { ...original, revision: current.revision }, { userId: 28 });
    }
  });
  it.each(['', 'project'])('requires final operation authorization without a human identity: %s', async (path) => {
    permissions.set(path, { allowed: false, params: {} });
    await node({ params: { fields: ['name'], appends: ['project.name'] } });
    const { execution, jobs } = await execute('B', false);
    expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
    expect(jobs[0].status).toBe(JOB_STATUS.ERROR);
    expect(jobs[0].result.message).toMatch(/authoriz/);
    expect(jobs[0].result).not.toHaveProperty('0');
  });
  it.each([
    ['accessWorkflowDocuments', 'role.name', 'worker'],
    ['accessWorkflowDocuments', 'user.id', '28'],
    ['accessWorkflowProjects', 'role.name', 'worker'],
    ['accessWorkflowProjects', 'user.id', '28'],
  ] as const)('rejects missing rule context without borrowing event identity: %s %s', async (name, path, value) => {
    const target = identities.get(name)!;
    const original = (await store.read(target))!;
    try {
      const rules = original.rules.map((rule) => ({
        ...rule,
        subject: {
          type: 'compare' as const,
          operator: 'eq' as const,
          left: { type: 'context' as const, path },
          right: { type: 'literal' as const, value },
        },
      }));
      await store.save(target, { ...original, rules }, { userId: 28 });
      await node({ params: { fields: ['name'], appends: ['project.name'] } });
      const authorized = await execute();
      expect(authorized.execution.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(authorized.jobs[0].result).toEqual([
        { name: 'Owned', project: { name: 'Local project' } },
        { name: 'Visible', project: null },
      ]);
      const { execution, jobs } = await execute('B', false);
      expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
      expect(jobs[0].status).toBe(JOB_STATUS.ERROR);
      expect(jobs[0].result.message).toContain(`Missing or invalid trusted context: ${path}`);
      expect(jobs[0].result).not.toHaveProperty('0');
    } finally {
      const current = (await store.read(target))!;
      await store.save(target, { ...original, revision: current.revision }, { userId: 28 });
    }
  });
  it('rejects an automatic query without its required trusted tenant', async () => {
    await node({ params: { fields: ['name'] } });
    const { execution, jobs } = await execute(null, false);
    expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
    expect(jobs[0].result.message).toContain('Missing or invalid trusted context: tenant.id');
  });
  it('applies the finalized role filter in addition to ownership and visibility', async () => {
    permissions.set('', { allowed: true, params: { fields: ['name', 'amount'], filter: { amount: { $lt: 20 } } } });
    await node({ params: { fields: ['name'] } });
    const { execution, jobs } = await execute();
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(jobs[0].result).toEqual([{ name: 'Owned' }]);
  });
  it('saves an authorization failure without unrestricted query results', async () => {
    permissions.set('', { allowed: false, params: {} });
    await node({ params: { fields: ['name'] } });
    const { execution, jobs } = await execute();
    expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
    expect(jobs[0].status).toBe(JOB_STATUS.ERROR);
    expect(jobs[0].result.message).toMatch(/authoriz/);
    expect(jobs[0].result).not.toHaveProperty('0');
  });
  it('keeps failOnEmpty for a single query that only matches an unreadable record', async () => {
    await node({ multiple: false, failOnEmpty: true, params: { fields: ['name'], filter: { id: 3 } } });
    const { execution, jobs } = await execute();
    expect(execution.status).toBe(EXECUTION_STATUS.FAILED);
    expect(jobs[0].status).toBe(JOB_STATUS.FAILED);
    expect(jobs[0].result).toBeNull();
  });
  it('passes authorized single results to the next real query node', async () => {
    const first = await node({ multiple: false, params: { fields: ['id'], filter: { id: 2 } } }, { key: 'selected' });
    const second = await node(
      { multiple: false, params: { fields: ['name'], filter: { id: '{{$jobsMapByNodeKey.selected.id}}' } } },
      { upstreamId: first.id },
    );
    await first.update({ downstreamId: second.id });
    const { execution, jobs } = await execute();
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(jobs.map((job) => job.result)).toEqual([{ id: 2 }, { name: 'Visible' }]);
  });
  it('does not substitute an event payload tenant when trusted execution tenant is missing', async () => {
    await node({ params: { fields: ['name'] } });
    const { execution, jobs } = await execute(null);
    expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
    expect(jobs[0].status).toBe(JOB_STATUS.ERROR);
    expect(jobs[0].result.message).toMatch(/context|tenant/i);
  });
  it('loads current visibility rules in a new execution phase', async () => {
    await node({ params: { fields: ['name'] } });
    const target = identities.get('accessWorkflowDocuments')!;
    const original = (await store.read(target))!;
    try {
      expect((await execute()).jobs[0].result).toEqual([{ name: 'Owned' }, { name: 'Visible' }]);
      await store.save(target, { ...original, rules: [original.rules[0]] }, { userId: 28 });
      expect((await execute()).jobs[0].result).toEqual([{ name: 'Owned' }]);
    } finally {
      const current = (await store.read(target))!;
      await store.save(target, { ...original, revision: current.revision }, { userId: 28 });
    }
  });
});

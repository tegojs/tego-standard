import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import WorkflowPlugin, { EXECUTION_STATUS, JOB_STATUS } from '../../../../../module-workflow/src/server';
import AggregateInstruction, {
  type WorkflowAggregateReadRequest,
} from '../../../../../module-workflow/src/server/features/aggregate/AggregateInstruction';
import { accessConfigHistory } from '../../access-control/config-history';
import type { AccessCollectionIdentity } from '../../access-control/config-store';
import { AccessMainWorkflowQueryRuntime } from '../../access-control/main-workflow-query-runtime';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreFactoryEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreFactoryEntry)('authenticated workflow aggregate read boundary', () => {
  let app: MockServer;
  let plugin: WorkflowPlugin;
  let runtime: AccessMainWorkflowQueryRuntime;
  let source: AccessCollectionIdentity;
  let legacySource: AccessCollectionIdentity;
  let selected: AccessCollectionIdentity[];
  let guardOverride: ((request: WorkflowAggregateReadRequest) => unknown) | undefined;
  let captured: WorkflowAggregateReadRequest | undefined;
  let token: string;
  let userId: number;
  let workflow;
  const role = 'aggregate-boundary-participant';
  const password = 'workflow-aggregate-boundary-password';
  const agent = () =>
    app
      .agent()
      .set('Authorization', `Bearer ${token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', role)
      .set('X-Tenant-Id', 'B');

  beforeAll(async () => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreFactoryEntry!).href);
    app = await createTenantApp({
      aclFactory: createACL,
      database: { dialect: 'sqlite', storage: ':memory:' },
      extraPlugins: [
        [
          'workflow',
          {
            queryResolver: (request) => runtime.resolve(request, selected),
            aggregateGuard: (request) => {
              captured = request;
              expect(() => plugin.captureDataOperationAuthority(request)).toThrow(/authority is unavailable/);
              if (guardOverride) return guardOverride(request);
              return runtime.assertAggregateBoundary(request, selected);
            },
          },
        ],
      ],
    });
    plugin = app.pm.get('workflow') as WorkflowPlugin;
    runtime = new AccessMainWorkflowQueryRuntime(app, (request) => plugin.captureDataOperationAuthority(request));
    for (const id of ['H', 'B', 'C'])
      await app.db.getRepository('tenants').create({ values: { id, name: id, enabled: true } });
    await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
    const user = await app.db.getRepository('users').create({
      values: { username: role, password, roles: [role], tenants: ['B'], defaultTenantId: 'B' },
    });
    userId = user.get('id');
    const signedIn = await app
      .agent()
      .post('/auth:signIn')
      .set('X-Authenticator', 'basic')
      .send({ account: role, password });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.data.user.id).toBe(userId);
    expect(signedIn.body.data.user.hasPassword).toBe(true);
    token = signedIn.body.data.token;
    expect(token).toEqual(expect.any(String));
    const stored = await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: 'authenticatedAggregateDocuments',
        tenancy: 'tenantScoped',
        timestamps: false,
        createdBy: false,
        updatedBy: false,
        fields: [
          { name: 'name', type: 'string' },
          { name: 'amount', type: 'integer' },
        ],
      },
    });
    source = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName: stored.get('name') };
    await app.db.getCollection(source.collectionName).model.bulkCreate([
      { id: 1, name: 'Owned H', amount: 100, tenantId: 'H' },
      { id: 2, name: 'Owned B', amount: 200, tenantId: 'B' },
      { id: 3, name: 'Owned C', amount: 300, tenantId: 'C' },
    ]);
    await app.db.getRepository('collections').create({
      context: {},
      values: { name: 'authenticatedAggregateEvents', tenancy: 'shared', fields: [{ name: 'name', type: 'string' }] },
    });
    const legacy = await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: 'legacyAggregateSources',
        tenancy: 'tenantScoped',
        timestamps: false,
        createdBy: false,
        updatedBy: false,
        fields: [
          { name: 'name', type: 'string' },
          { name: 'amount', type: 'integer' },
          { name: 'document', type: 'belongsTo', target: source.collectionName, foreignKey: 'documentId' },
        ],
      },
    });
    legacySource = { dataSourceKey: 'main', collectionKey: legacy.get('key'), collectionName: legacy.get('name') };
    await app.db.getRepository('fields').create({
      context: {},
      values: {
        name: 'sources',
        type: 'hasMany',
        collectionName: source.collectionName,
        target: legacySource.collectionName,
        foreignKey: 'documentId',
      },
    });
    await app.db.getCollection(legacySource.collectionName).model.bulkCreate([
      { id: 1, name: 'Legacy B', amount: 7, documentId: 2, tenantId: 'B' },
      { id: 2, name: 'Legacy C', amount: 9, documentId: 3, tenantId: 'C' },
    ]);
    await app.db.collection(accessConfigHistory).model.sync();
    await runtime.registry.store.save(source, { ...configFor(ownerCondition), revision: 0, rules: [] }, { userId });
    await runtime.registry.store.save(
      legacySource,
      { ...configFor(ownerCondition), revision: 0, rules: [] },
      { userId },
    );
  });

  beforeEach(async () => {
    selected = [{ ...source }];
    guardOverride = undefined;
    captured = undefined;
    workflow = await app.db.getRepository('workflows').create({
      values: {
        title: 'Authenticated aggregate read boundary',
        type: 'collection',
        enabled: true,
        sync: true,
        config: { collection: 'authenticatedAggregateEvents', mode: 1 },
      },
    });
  });

  afterEach(async () => {
    await workflow?.update({ enabled: false });
  });
  afterAll(async () => {
    await app?.destroy();
  });

  async function rows() {
    return (await app.db.getCollection(source.collectionName).model.findAll({ order: [['id', 'ASC']] })).map((row) =>
      row.get(),
    );
  }

  async function businessRows() {
    return {
      documents: await rows(),
      sources: (await app.db.getCollection(legacySource.collectionName).model.findAll({ order: [['id', 'ASC']] })).map(
        (row) => row.get(),
      ),
    };
  }

  async function execute() {
    const previousCount = await workflow.countExecutions();
    const triggered = await agent()
      .resource('workflows')
      .trigger({ filterByTk: workflow.id, updateData: encodeURIComponent(JSON.stringify({})) });
    expect([200, 204]).toContain(triggered.status);
    await vi.waitFor(
      async () => {
        expect(await workflow.countExecutions()).toBe(previousCount + 1);
        const [execution] = await workflow.getExecutions({ order: [['id', 'DESC']] });
        expect([EXECUTION_STATUS.RESOLVED, EXECUTION_STATUS.ERROR]).toContain(execution?.status);
      },
      { timeout: 10000, interval: 50 },
    );
    const [execution] = await workflow.getExecutions({ order: [['id', 'DESC']] });
    const [job] = await execution.getJobs();
    expect(execution.authContext).toEqual({ currentRole: role, currentUserId: userId });
    expect(execution.tenantId).toBe('B');
    expect(execution.tenantContext.currentTenantId).toBe('B');
    return { execution, job };
  }

  it.each([
    { aggregator: 'count', field: 'id', legacy: 1 },
    { aggregator: 'sum', field: 'amount', legacy: 200 },
  ])(
    'refuses selected $aggregator instead of disclosing a denied business result',
    async ({ aggregator, field, legacy }) => {
      const before = await rows();
      expect(before).toEqual([
        { id: 1, name: 'Owned H', amount: 100, tenantId: 'H' },
        { id: 2, name: 'Owned B', amount: 200, tenantId: 'B' },
        { id: 3, name: 'Owned C', amount: 300, tenantId: 'C' },
      ]);
      const direct = await agent().resource(source.collectionName).list();
      expect(direct.status).toBe(403);
      const node = await workflow.createNode({
        type: 'query',
        config: { collection: source.collectionName, multiple: true, params: { fields: ['id'], paginate: false } },
      });
      const query = await execute();
      expect(query.execution.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(query.job.result).toEqual([]);
      await node.update({
        type: 'aggregate',
        config: { collection: source.collectionName, aggregator, params: { field } },
      });
      selected = [];
      const baseline = await execute();
      expect(baseline.execution.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(baseline.job.result).toBe(legacy);
      selected = [{ ...source }];
      const denied = await execute();
      expect(await rows()).toEqual(before);
      expect({ status: denied.execution.status, result: denied.job.result }).toEqual({
        status: EXECUTION_STATUS.ERROR,
        result: expect.objectContaining({
          message: expect.stringMatching(/Selected workflow aggregate reads require a dedicated adapter/),
        }),
      });
      expect(denied.job.status).toBe(JOB_STATUS.ERROR);
      expect(denied.job.result.message).toMatch(/Selected workflow aggregate reads require a dedicated adapter/);
      expect(Object.isFrozen(captured)).toBe(true);
      expect(captured.collection).toBe(app.db.getCollection(source.collectionName));
      expect(await rows()).toEqual(before);
      selected = [];
      const restored = await execute();
      expect(restored.execution.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(restored.job.result).toBe(legacy);
      expect(await rows()).toEqual(before);
    },
  );

  it('refuses a legacy aggregate filter that reads a selected target and restores the same node when unselected', async () => {
    const before = await businessRows();
    await workflow.createNode({
      type: 'aggregate',
      config: {
        collection: legacySource.collectionName,
        aggregator: 'sum',
        params: { field: 'amount', filter: { 'document.name': 'Owned B' } },
      },
    });
    selected = [];
    const baseline = await execute();
    expect(baseline.execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(baseline.job.result).toBe(7);
    selected = [{ ...source }];
    const denied = await execute();
    expect(denied.execution.status).toBe(EXECUTION_STATUS.ERROR);
    expect(denied.job.result.message).toMatch(
      /Legacy reads of selected access collections require a dedicated adapter/,
    );
    expect(await businessRows()).toEqual(before);
    selected = [];
    const restored = await execute();
    expect(restored.execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(restored.job.result).toBe(7);
    expect(await businessRows()).toEqual(before);
  });

  it('keeps an unrelated selection without blocking the legacy scalar aggregate', async () => {
    const before = await businessRows();
    await workflow.createNode({
      type: 'aggregate',
      config: { collection: legacySource.collectionName, aggregator: 'sum', params: { field: 'amount' } },
    });
    const result = await execute();
    expect(result.execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(result.job.result).toBe(7);
    expect(await businessRows()).toEqual(before);
  });

  it.each(['target', 'source'] as const)(
    'checks the actual associated %s instead of the declared root collection',
    async (side) => {
      const before = await businessRows();
      await workflow.createNode({
        type: 'aggregate',
        config: {
          collection: 'authenticatedAggregateEvents',
          associated: true,
          association: { associatedCollection: source.collectionName, associatedKey: 2, name: 'sources' },
          aggregator: 'sum',
          params: { field: 'amount' },
        },
      });
      selected = [];
      const baseline = await execute();
      expect(baseline.execution.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(baseline.job.result).toBe(7);
      selected = [{ ...(side === 'target' ? legacySource : source) }];
      const denied = await execute();
      expect(denied.execution.status).toBe(EXECUTION_STATUS.ERROR);
      expect(denied.job.result.message).toMatch(/require a dedicated adapter/);
      expect(Object.isFrozen(captured)).toBe(true);
      expect(Object.isFrozen(captured.association)).toBe(true);
      expect(captured.collection).toBe(app.db.getCollection(legacySource.collectionName));
      expect(captured.association.collection).toBe(app.db.getCollection(source.collectionName));
      expect(await businessRows()).toEqual(before);
      selected = [];
      const restored = await execute();
      expect(restored.execution.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(restored.job.result).toBe(7);
      expect(await businessRows()).toEqual(before);
    },
  );

  it.each(['promise', 'value', 'throw'] as const)('does not fall back after a %s guard result', async (mode) => {
    const before = await businessRows();
    selected = [];
    guardOverride = () => {
      if (mode === 'promise') return Promise.resolve(undefined);
      if (mode === 'value') return true;
      throw new Error('Aggregate guard rejected the read');
    };
    await workflow.createNode({
      type: 'aggregate',
      config: { collection: source.collectionName, aggregator: 'sum', params: { field: 'amount' } },
    });
    const denied = await execute();
    expect(denied.execution.status).toBe(EXECUTION_STATUS.ERROR);
    expect(denied.job.status).toBe(JOB_STATUS.ERROR);
    expect(denied.job.result.message).toMatch(/guard must return undefined synchronously|guard rejected the read/);
    expect(await businessRows()).toEqual(before);
  });

  it('captures the startup callback and rejects a non-function installation', async () => {
    const before = await businessRows();
    const original = plugin.options.aggregateGuard;
    try {
      plugin.options.aggregateGuard = true as never;
      expect(() => new AggregateInstruction(plugin)).toThrow(/aggregate guard must be a function/);
      plugin.options.aggregateGuard = () => undefined;
      await workflow.createNode({
        type: 'aggregate',
        config: { collection: source.collectionName, aggregator: 'count', params: { field: 'id' } },
      });
      const denied = await execute();
      expect(denied.execution.status).toBe(EXECUTION_STATUS.ERROR);
      expect(denied.job.result.message).toMatch(/Selected workflow aggregate reads require a dedicated adapter/);
      expect(await businessRows()).toEqual(before);
    } finally {
      plugin.options.aggregateGuard = original;
    }
  });
});

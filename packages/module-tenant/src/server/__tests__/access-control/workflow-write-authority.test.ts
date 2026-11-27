import { createMockServer, type MockServer } from '@tachybase/test';
import { ACL, Transaction, type Context } from '@tego/server';

import { retry as retryExecution } from '../../../../../module-workflow/src/server/actions/executions';
import { EXECUTION_STATUS, JOB_STATUS } from '../../../../../module-workflow/src/server/constants';
import type DelayInstruction from '../../../../../module-workflow/src/server/features/delay/DelayInstruction';
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
import { AccessWorkflowRootHandler } from '../../access-control/workflow-root-handler';
import { AccessWorkflowWriteTransactionPlanner } from '../../access-control/workflow-write-transaction';
import { configFor, ownerCondition } from './fixtures';

describe('configured workflow scalar writes with tenant ownership', () => {
  let app: MockServer;
  let plugin: WorkflowPlugin;
  let adapter: AccessAclScopeAdapter;
  let store: AccessConfigStore;
  let handler: AccessWorkflowRootHandler;
  let queries: AccessQueryService;
  let planner: AccessWorkflowWriteTransactionPlanner;
  let planning: boolean;
  let planningCalls: number;
  let afterPlan: (() => Promise<void>) | undefined;
  let source: AccessCollectionIdentity;
  let documents;
  let workflow;
  let request;
  let clone: boolean;
  let wrongAction: boolean;
  let failUpdate: boolean;
  let tamperCreate: boolean;
  let intercept: (() => void) | undefined;
  let releaseAfterWrite: boolean;
  const identity = (collection) => (collection === documents ? source : undefined);
  const baseConfig = () => {
    const config = configFor(ownerCondition);
    config.rules.push({
      ...configFor(
        {
          type: 'any',
          children: [
            {
              type: 'compare',
              operator: 'eq',
              left: { type: 'field', path: 'name' },
              right: { type: 'literal', value: 'Visible' },
            },
            { type: 'isNull', operand: { type: 'field', path: 'tenantId' } },
          ],
        },
        'visibility',
      ).rules[0],
      id: 'visible',
    });
    return config;
  };

  beforeAll(async () => {
    const plan = async (target) => {
      if (!planning) return;
      planningCalls++;
      const options = await planner.plan(target);
      await afterPlan?.();
      return options;
    };
    app = await createMockServer({
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: [
        'error-handler',
        'collection',
        'user',
        [
          'workflow',
          {
            createTransactionPlanner: plan,
            updateTransactionPlanner: plan,
            createResolver: () => async (input) => {
              request = input;
              intercept?.();
              return wrongAction ? handler.update(input) : handler.create(clone ? { ...input } : input);
            },
            updateResolver: () => async (input) => {
              request = input;
              intercept?.();
              return wrongAction ? handler.create(input) : handler.update(clone ? { ...input } : input);
            },
          },
        ],
      ],
    });
    plugin = app.pm.get('workflow') as WorkflowPlugin;
    const stored = await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: 'writeScopeDocuments',
        fields: [
          { name: 'name', type: 'string', defaultValue: 'Draft' },
          { name: 'tenantId', type: 'string' },
          { name: 'amount', type: 'integer', defaultValue: 10 },
          { name: 'active', type: 'boolean' },
          { name: 'scheduledAt', type: 'date' },
          { name: 'payload', type: 'json' },
          { name: 'parent', type: 'belongsTo', target: 'writeScopeDocuments', foreignKey: 'parentId' },
        ],
      },
    });
    source = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName: 'writeScopeDocuments' };
    documents = app.db.getCollection(source.collectionName);
    await documents.model.sync();
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
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, app.db);
    planner = new AccessWorkflowWriteTransactionPlanner(app.db, store, identity);
    queries = new AccessQueryService(app.db, adapter, stableKey);
    handler = new AccessWorkflowRootHandler(app.db, adapter, queries, identity, (input) =>
      plugin.captureDataOperationAuthority(input),
    );
    plugin.options.createTransactionPlanner = plugin.options.updateTransactionPlanner = () => {
      throw new Error('startup planner was not captured');
    };
    app.db.on(`${source.collectionName}.afterUpdate`, (record) => {
      if (failUpdate && record.get('id') === 3) throw new Error('later update failed');
      if (releaseAfterWrite) adapter.release(request.context);
    });
    app.db.on(`${source.collectionName}.afterCreate`, async (record, options) => {
      if (tamperCreate)
        await documents.model.update(
          { tenantId: 'C' },
          {
            where: { id: record.get('id') },
            transaction: options.transaction,
            hooks: false,
          },
        );
    });
  });
  beforeEach(async () => {
    clone = wrongAction = failUpdate = tamperCreate = false;
    planning = false;
    planningCalls = 0;
    afterPlan = undefined;
    intercept = undefined;
    releaseAfterWrite = false;
    request = undefined;
    const current = await store.read(source);
    await store.save(source, { ...baseConfig(), revision: current?.revision ?? 0 }, { userId: 28 });
    await documents.model.destroy({ where: {}, hooks: false });
    await documents.model.bulkCreate([
      { id: 1, name: 'Owned', tenantId: 'B', amount: 10 },
      { id: 2, name: 'Visible', tenantId: 'H', amount: 20 },
      { id: 3, name: 'Second', tenantId: 'B', amount: 30 },
      { id: 4, name: 'Hidden', tenantId: 'C', amount: 40 },
      { id: 5, name: 'Legacy', tenantId: null, amount: 50 },
    ]);
    workflow = await app.db.getRepository('workflows').create({
      values: {
        title: 'Configured ownership write',
        type: 'collection',
        sync: true,
        enabled: true,
        config: { collection: 'writeScopeEvents', mode: 1 },
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

  async function execute(
    kind: 'create' | 'update',
    params: object,
    state: object = { currentTenantId: 'B' },
    immediate: boolean | null = true,
    payload?: object,
  ) {
    await workflow.createNode({ type: kind, config: { collection: source.collectionName, params } });
    const transaction =
      immediate === null
        ? undefined
        : await app.db.sequelize.transaction({
            type: immediate ? Transaction.TYPES.IMMEDIATE : Transaction.TYPES.DEFERRED,
          });
    try {
      await plugin.trigger(
        workflow,
        { payload, state: { currentTenantId: 'C', currentRole: 'root' } },
        { transaction, context: { state } },
      );
      const [execution] = await workflow.getExecutions({ transaction, order: [['id', 'DESC']] });
      const [job] = await execution.getJobs({ transaction });
      const result = { status: execution.status, result: job.result };
      if (transaction) {
        if (execution.status === EXECUTION_STATUS.RESOLVED) await transaction.commit();
        else await transaction.rollback();
      }
      return result;
    } catch (error) {
      if (transaction && !(transaction as Transaction & { finished?: string }).finished) await transaction.rollback();
      throw error;
    }
  }
  const get = async (id: number) => (await documents.model.findByPk(id))?.get({ plain: true });
  async function saveConfig(config) {
    const current = (await store.read(source))!;
    await store.save(source, { ...config, revision: current.revision }, { userId: 28 });
  }

  describe('node-owned transactions planned from current policy', () => {
    it('uses the actual selection filter to reject SQLite relationship planning before selecting a writer', async () => {
      planning = true;
      const job = await execute(
        'update',
        {
          filter: { parent: { name: 'Hidden' } },
          values: { name: 'No' },
        },
        { currentTenantId: 'B' },
        null,
      );
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(job.result.message).toMatch(/PostgreSQL/i);
      expect(planningCalls).toBe(1);
      expect(request).toBeUndefined();
      expect((await get(1)).name).toBe('Owned');
    });

    it('keeps scalar selection planning compatible with the ownership-checked writer', async () => {
      planning = true;
      const job = await execute(
        'update',
        {
          filter: { name: 'Owned' },
          values: { name: 'Planned selection' },
        },
        { currentTenantId: 'B' },
        null,
      );
      expect(job.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(planningCalls).toBe(1);
      expect((request.transaction as Transaction & { options: { type: string } }).options.type).toBe(
        Transaction.TYPES.IMMEDIATE,
      );
      expect(await get(1)).toMatchObject({ name: 'Planned selection', tenantId: 'B' });
    });

    it.each(['create', 'update'] as const)(
      'rejects SQLite %s references during planning before execution',
      async (kind) => {
        planning = true;
        const job = await execute(
          kind,
          { ...(kind === 'update' ? { filterByTk: 1 } : {}), values: { parent: 3 } },
          { currentTenantId: 'B' },
          null,
        );
        expect(job.status).toBe(EXECUTION_STATUS.ERROR);
        expect(job.result.message).toMatch(/PostgreSQL/i);
        expect(planningCalls).toBe(1);
        expect(request).toBeUndefined();
        expect((await get(1)).parentId).toBeNull();
      },
    );
    it.each(['create', 'update'] as const)('plans and commits %s without a caller transaction', async (kind) => {
      planning = true;
      const job = await execute(
        kind,
        {
          ...(kind === 'update' ? { filterByTk: 1 } : {}),
          values: { ...(kind === 'create' ? { id: 100 } : {}), name: 'Planned' },
        },
        { currentTenantId: 'B' },
        null,
      );
      expect(job.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(planningCalls).toBe(1);
      expect((request.transaction as Transaction & { options: { type: string } }).options.type).toBe(
        Transaction.TYPES.IMMEDIATE,
      );
      expect(await get(kind === 'create' ? 100 : 1)).toMatchObject({ name: 'Planned', tenantId: 'B' });
      expect(() => plugin.captureDataOperationAuthority(request)).toThrow(/authority/i);
    });
    it.each(['create', 'update'] as const)('does not grant %s when planning succeeded but G is empty', async (kind) => {
      planning = true;
      await saveConfig({ ...baseConfig(), rules: [] });
      const job = await execute(
        kind,
        {
          ...(kind === 'update' ? { filterByTk: 1 } : {}),
          values: { ...(kind === 'create' ? { id: 100 } : {}), name: 'No G' },
        },
        { currentTenantId: 'B' },
        null,
      );
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(planningCalls).toBe(1);
      expect(await get(100)).toBeUndefined();
      expect((await get(1)).name).toBe('Owned');
    });
    it.each(['create', 'update'] as const)(
      'does not replace an insufficient caller transaction for %s',
      async (kind) => {
        planning = true;
        const job = await execute(
          kind,
          {
            ...(kind === 'update' ? { filterByTk: 1 } : {}),
            values: { name: 'Weak' },
          },
          { currentTenantId: 'B' },
          false,
        );
        expect(job.status).toBe(EXECUTION_STATUS.ERROR);
        expect(job.result.message).toMatch(/immediate/i);
        expect(planningCalls).toBe(0);
        expect((await get(1)).name).toBe('Owned');
      },
    );
    it.each(['create', 'update'] as const)(
      'stops %s before execution when current policy cannot be loaded',
      async (kind) => {
        planning = true;
        vi.spyOn(store, 'read').mockRejectedValue(new Error('policy database unavailable'));
        const job = await execute(
          kind,
          {
            ...(kind === 'update' ? { filterByTk: 1 } : {}),
            values: { name: 'No fallback' },
          },
          { currentTenantId: 'B' },
          null,
        );
        expect(job.status).toBe(EXECUTION_STATUS.ERROR);
        expect(job.result.message).toBe('policy database unavailable');
        expect(request === undefined).toBe(true);
        expect((await get(1)).name).toBe('Owned');
      },
    );
    it.each(['create', 'update'] as const)(
      'rechecks stricter G after %s planning rather than trusting earlier settings',
      async (kind) => {
        planning = true;
        afterPlan = async () =>
          saveConfig(
            configFor({
              type: 'tenantRelation',
              tenant: { type: 'field', path: 'tenantId' },
              relation: 'descendant',
              includeSelf: true,
            }),
          );
        const job = await execute(
          kind,
          {
            ...(kind === 'update' ? { filterByTk: 1 } : {}),
            values: { name: 'Stale policy' },
          },
          { currentTenantId: 'B' },
          null,
        );
        expect(job.status).toBe(EXECUTION_STATUS.ERROR);
        expect(job.result.message).toMatch(/PostgreSQL/i);
        expect((await get(1)).name).toBe('Owned');
      },
    );
    it('rolls back all planned updates when a later update hook fails', async () => {
      planning = true;
      failUpdate = true;
      const job = await execute('update', { values: { name: 'No partial commit' } }, { currentTenantId: 'B' }, null);
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(job.result.message).toBe('later update failed');
      expect((await get(1)).name).toBe('Owned');
      expect((await get(3)).name).toBe('Second');
    });
    it('rolls back created data when a hook changes its ownership', async () => {
      planning = true;
      tamperCreate = true;
      const job = await execute('create', { values: { id: 100, name: 'Tampered' } }, { currentTenantId: 'B' }, null);
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(job.result.message).toMatch(/changed record ownership/i);
      expect(await get(100)).toBeUndefined();
    });
    it.each(['create', 'update'] as const)(
      'rejects shared expression values changed during %s planning',
      async (kind) => {
        planning = true;
        let payload;
        const createProcessor = plugin.createProcessor.bind(plugin);
        vi.spyOn(plugin, 'createProcessor').mockImplementation((execution, options) => {
          const processor = createProcessor(execution, options);
          const parse = processor.getParsedValue.bind(processor);
          processor.getParsedValue = (...args) => {
            const result = parse(...args);
            if (result?.values?.name === 'Captured') {
              payload = result.values;
              expect(payload === execution.context.payload).toBe(true);
            }
            return result;
          };
          return processor;
        });
        afterPlan = async () => {
          payload.name = 'Injected';
        };
        const job = await execute(
          kind,
          {
            ...(kind === 'update' ? { filterByTk: 1 } : {}),
            values: '{{$context.payload}}',
          },
          { currentTenantId: 'B' },
          null,
          { name: 'Captured' },
        );
        expect(job.status).toBe(EXECUTION_STATUS.ERROR);
        expect(job.result.message).toMatch(/inputs changed during planning/i);
        expect(request === undefined).toBe(true);
        expect(await documents.model.count()).toBe(5);
        expect((await get(1)).name).toBe('Owned');
      },
    );
  });

  it('creates with actual defaults and current ownership using the original transaction', async () => {
    const job = await execute('create', { values: { id: 100 } });
    expect(job.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result).toMatchObject({ id: 100, name: 'Draft', amount: 10, tenantId: 'B' });
    expect(await get(100)).toMatchObject({ tenantId: 'B', name: 'Draft' });
    expect(() => adapter.configuration(request.context, source)).toThrow();
    expect(() => plugin.captureDataOperationAuthority(request)).toThrow(/authority/i);
  });
  it('updates only matching G records and returns persisted rows in stable key order', async () => {
    const job = await execute('update', { filter: { amount: { $gte: 10 } }, values: { name: 'Edited' } });
    expect(job.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result).toMatchObject({
      length: 2,
      data: [
        { id: 1, name: 'Edited' },
        { id: 3, name: 'Edited' },
      ],
    });
    expect((await get(2)).name).toBe('Visible');
    expect((await get(4)).name).toBe('Hidden');
    expect((await get(5)).tenantId).toBeNull();
  });
  it('allows a valid zero-match update', async () => {
    const job = await execute('update', { filter: { id: 999 }, values: { name: 'Unused' } });
    expect(job).toEqual({ status: EXECUTION_STATUS.RESOLVED, result: { length: 0, data: [] } });
  });
  it('updates a zero primary key without losing its selection', async () => {
    await documents.model.create({ id: 0, name: 'Zero', tenantId: 'B', amount: 0 });
    const job = await execute('update', { filterByTk: 0, values: { name: 'Zero edited' } });
    expect(job).toMatchObject({
      status: EXECUTION_STATUS.RESOLVED,
      result: { length: 1, data: [{ id: 0, name: 'Zero edited' }] },
    });
    expect((await get(0)).name).toBe('Zero edited');
    expect((await get(1)).name).toBe('Owned');
    expect((await get(4)).name).toBe('Hidden');
  });
  it('rejects target-key drift after ownership selection and preserves every record', async () => {
    await documents.model.update({ amount: 1 }, { where: { id: 4 }, hooks: false });
    const scope = queries.scopeQuery.bind(queries);
    const targetKey = documents.options.filterTargetKey;
    vi.spyOn(queries, 'scopeQuery').mockImplementation(async (...args) => {
      const result = await scope(...args);
      documents.options.filterTargetKey = 'amount';
      return result;
    });
    let job;
    try {
      job = await execute('update', { filter: { id: 1 }, values: { name: 'Wrong target' } });
    } finally {
      documents.options.filterTargetKey = targetKey;
    }
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect((await get(1)).name).toBe('Owned');
    expect((await get(4)).name).toBe('Hidden');
  });
  it.each(['create', 'update'] as const)('preserves persisted scalar value types in %s results', async (kind) => {
    const values = {
      active: true,
      scheduledAt: '2026-10-22T03:04:05.000Z',
      payload: { label: 'Typed', flags: [true, false] },
    };
    const job = await execute(kind, {
      ...(kind === 'update' ? { filterByTk: 1 } : {}),
      values: { ...(kind === 'create' ? { id: 100 } : {}), ...values },
    });
    expect(job.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(kind === 'create' ? job.result : job.result.data[0]).toMatchObject(values);
  });
  it.each([2, 4, [1, 2]])('rejects an explicit selection containing any record without G: %j', async (key) => {
    const job = await execute('update', { filterByTk: key, values: { name: 'Forbidden' } });
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect((await get(1)).name).toBe('Owned');
    expect((await get(2)).name).toBe('Visible');
  });
  it('rejects edits of visible read-only legacy data', async () => {
    const job = await execute('update', { filterByTk: 5, values: { name: 'No claim' } });
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.result.message).toMatch(/Legacy record.*cannot be edited/i);
    expect((await get(5)).tenantId).toBeNull();
  });
  it('claims editable legacy data through the common update service', async () => {
    const config = baseConfig();
    config.rules.push({
      ...configFor({ type: 'isNull', operand: { type: 'field', path: 'tenantId' } }).rules[0],
      id: 'legacy-edit',
    });
    await saveConfig(config);
    const job = await execute('update', { filterByTk: 5, values: { name: 'Claimed', tenantId: null } });
    expect(job.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result).toMatchObject({ length: 1, data: [{ id: 5, tenantId: 'B', name: 'Claimed' }] });
    expect((await get(5)).tenantId).toBe('B');
  });
  it.each(['create', 'update'] as const)('does not turn an empty G into write permission on %s', async (kind) => {
    await saveConfig({ ...baseConfig(), rules: [] });
    const job = await execute(
      kind,
      kind === 'create' ? { values: { id: 100, name: 'No' } } : { filter: {}, values: { name: 'No' } },
    );
    if (kind === 'create') {
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(await get(100)).toBeUndefined();
    } else expect(job).toEqual({ status: EXECUTION_STATUS.RESOLVED, result: { length: 0, data: [] } });
    expect((await get(1)).name).toBe('Owned');
  });
  it.each(['create', 'update'] as const)(
    'uses captured values and identity across configuration awaits on %s',
    async (kind) => {
      const read = store.read.bind(store);
      vi.spyOn(store, 'read').mockImplementation(async (source) => {
        const config = await read(source);
        request.params.values.name = 'Injected';
        request.context.state.currentTenantId = 'C';
        return config;
      });
      const job = await execute(kind, {
        ...(kind === 'update' ? { filterByTk: 1 } : {}),
        values: { ...(kind === 'create' ? { id: 100 } : {}), name: 'Captured' },
      });
      expect(job.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(await get(kind === 'create' ? 100 : 1)).toMatchObject({ name: 'Captured', tenantId: 'B' });
    },
  );
  it.each(['create', 'update'] as const)('rejects missing canonical tenant identity on %s', async (kind) => {
    const job = await execute(
      kind,
      { ...(kind === 'update' ? { filterByTk: 1 } : {}), values: { name: 'No actor' } },
      {},
    );
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect((await get(1)).name).toBe('Owned');
  });
  it.each(['create', 'update'] as const)(
    'rejects a copied request before reading configuration on %s',
    async (kind) => {
      clone = true;
      const read = vi.spyOn(store, 'read');
      const job = await execute(kind, { values: { name: 'Copy' } });
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(job.result.message).toMatch(/authority/i);
      expect(read).not.toHaveBeenCalled();
    },
  );
  it.each(['create', 'update'] as const)('does not let %s authority authorize the other write action', async (kind) => {
    wrongAction = true;
    const job = await execute(kind, { values: { name: 'Wrong action' } });
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.result.message).toMatch(/authority/i);
  });
  it.each(['create', 'update'] as const)('rejects an insufficient inherited transaction on %s', async (kind) => {
    const job = await execute(
      kind,
      { ...(kind === 'update' ? { filterByTk: 1 } : {}), values: { name: 'Weak transaction' } },
      { currentTenantId: 'B' },
      false,
    );
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.result.message).toMatch(/immediate/i);
    expect((await get(1)).name).toBe('Owned');
  });
  it('rolls back earlier updates when a later model hook fails', async () => {
    failUpdate = true;
    const job = await execute('update', { values: { name: 'Rollback' } });
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.result.message).toBe('later update failed');
    expect((await get(1)).name).toBe('Owned');
    expect((await get(3)).name).toBe('Second');
  });
  it('rejects a hook changing actual ownership during creation', async () => {
    tamperCreate = true;
    const job = await execute('create', { values: { id: 100, name: 'Tampered' } });
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.result.message).toMatch(/changed record ownership/i);
    expect(await get(100)).toBeUndefined();
  });
  it.each(['create', 'update'] as const)('does not let normal %s transfer ownership', async (kind) => {
    const job = await execute(kind, {
      ...(kind === 'update' ? { filterByTk: 1 } : {}),
      values: { tenantId: 'C', name: 'Transfer' },
    });
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.result.message).toMatch(/must belong to the current tenant|cannot transfer ownership/i);
    expect((await get(1)).tenantId).toBe('B');
  });

  it.each(['create', 'update'] as const)('rejects attachment interfaces before writing on %s', async (kind) => {
    const field = documents.getField('name');
    const original = field.options.interface;
    field.options.interface = 'attachment';
    try {
      const job = await execute(kind, {
        ...(kind === 'update' ? { filterByTk: 1 } : {}),
        values: { ...(kind === 'create' ? { id: 100 } : {}), name: 'resource-url' },
      });
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(job.result.message).toMatch(/attachment|interface/i);
      expect((await get(1)).name).toBe('Owned');
      expect(await get(100)).toBeUndefined();
    } finally {
      field.options.interface = original;
    }
  });

  it.each(['create', 'update'] as const)(
    'rejects interface changes during configuration loading on %s',
    async (kind) => {
      const field = documents.getField('name');
      const original = field.options.interface;
      const read = store.read.bind(store);
      vi.spyOn(store, 'read').mockImplementation(async (source) => {
        const config = await read(source);
        field.options.interface = 'attachment';
        return config;
      });
      try {
        const job = await execute(kind, {
          ...(kind === 'update' ? { filterByTk: 1 } : {}),
          values: { ...(kind === 'create' ? { id: 100 } : {}), name: 'captured-scalar' },
        });
        expect(job.status).toBe(EXECUTION_STATUS.ERROR);
        expect(job.result.message).toMatch(/interface|metadata/i);
        expect((await get(1)).name).toBe('Owned');
        expect(await get(100)).toBeUndefined();
      } finally {
        field.options.interface = original;
      }
    },
  );
  it.each(['create', 'update'] as const)('does not fall back when configuration loading fails on %s', async (kind) => {
    vi.spyOn(store, 'read').mockRejectedValue(new Error('configuration database unavailable'));
    const job = await execute(kind, {
      ...(kind === 'update' ? { filterByTk: 1 } : {}),
      values: { ...(kind === 'create' ? { id: 100 } : {}), name: 'Not written' },
    });
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.result.message).toBe('configuration database unavailable');
    expect((await get(1)).name).toBe('Owned');
    expect(await get(100)).toBeUndefined();
  });

  it.each(['create', 'update'] as const)('requires explicit configuration on %s', async (kind) => {
    vi.spyOn(store, 'read').mockResolvedValue(null);
    const job = await execute(kind, {
      ...(kind === 'update' ? { filterByTk: 1 } : {}),
      values: { name: 'No fallback' },
    });
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.result.message).toMatch(/explicit access configuration/i);
    expect((await get(1)).name).toBe('Owned');
  });

  it.each(['create', 'update'] as const)(
    'supports explicitly shared constant G without tenant identity on %s',
    async (kind) => {
      await saveConfig({ ...configFor({ type: 'constant', value: true }), ownership: { enabled: false } });
      const job = await execute(
        kind,
        {
          ...(kind === 'update' ? { filterByTk: 1 } : {}),
          values: { ...(kind === 'create' ? { id: 100 } : {}), name: 'Shared' },
        },
        {},
      );
      expect(job.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect((await get(kind === 'create' ? 100 : 1)).name).toBe('Shared');
    },
  );

  it.each(['create', 'update'] as const)(
    'rejects model metadata changes during configuration awaits on %s',
    async (kind) => {
      const attribute = documents.model.rawAttributes.amount;
      const field = attribute.field;
      const read = store.read.bind(store);
      vi.spyOn(store, 'read').mockImplementation(async (source) => {
        const config = await read(source);
        attribute.field = 'unexpected_amount';
        return config;
      });
      let job;
      try {
        job = await execute(kind, { ...(kind === 'update' ? { filterByTk: 1 } : {}), values: { name: 'Stale' } });
      } finally {
        attribute.field = field;
      }
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(job.result.message).toMatch(/metadata/i);
      expect((await get(1)).name).toBe('Owned');
    },
  );

  it.each(['create', 'update'] as const)('rejects input getters without invoking them on %s', async (kind) => {
    const getter = vi.fn(() => 'Unexpected');
    intercept = () => {
      Object.defineProperty(request.params.values, 'name', { get: getter, enumerable: true });
    };
    const read = vi.spyOn(store, 'read');
    const job = await execute(kind, { values: { name: 'Original' } });
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.result.message).toMatch(/accessors/i);
    expect(getter).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    { values: { parent: { id: 4 } } },
    { values: { parentId: 4 } },
    { values: { name: 'No' }, appends: ['parent'] },
    { values: { name: 'No' }, context: { state: { currentTenantId: 'C' } } },
  ])('rejects unsupported update payloads before any write: %j', async (params) => {
    const job = await execute('update', { filterByTk: 1, ...params });
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.result.message).toMatch(/adapter|parameters/i);
    expect((await get(1)).name).toBe('Owned');
    expect((await get(1)).parentId).toBeNull();
  });

  it('does not normalize a nonstandard key array into an accepted selection', async () => {
    class Keys extends Array<number> {}
    intercept = () => {
      request.params.filterByTk = new Keys(1);
      request.params.filterByTk[0] = 1;
    };
    const job = await execute('update', { filterByTk: 1, values: { name: 'No' } });
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.result.message).toMatch(/dense key/i);
    expect((await get(1)).name).toBe('Owned');
  });

  it('rejects relationship selection on SQLite without upgrading the caller transaction', async () => {
    const job = await execute('update', { filter: { parent: { name: 'Hidden' } }, values: { name: 'No' } });
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.result.message).toMatch(/PostgreSQL/i);
    expect((await get(1)).name).toBe('Owned');
  });

  it('checks the batch limit before changing any record', async () => {
    await documents.model.bulkCreate(
      Array.from({ length: 1001 }, (_, index) => ({ id: 1000 + index, tenantId: 'B', name: 'Bulk' })),
    );
    const job = await execute('update', { values: { name: 'No partial batch' } });
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.result.message).toMatch(/1000-record/i);
    expect((await get(1)).name).toBe('Owned');
    expect((await get(1000)).name).toBe('Bulk');
  });

  it('rolls back when the prepared phase is released during writing', async () => {
    releaseAfterWrite = true;
    const job = await execute('update', { filterByTk: 1, values: { name: 'No stale phase' } });
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.result.message).toMatch(/prepared|phase/i);
    expect((await get(1)).name).toBe('Owned');
  });
  describe('native user audit fields', () => {
    let userId: string | number;
    beforeAll(async () => {
      const user = await app.db.getCollection('users').model.create({ nickname: 'Audit workflow runner' });
      userId = user.get('id');
      // Real user-module interfaces register their context fields through field.afterAdd.
      documents.setField('createdBy', {
        type: 'belongsTo',
        target: 'users',
        foreignKey: 'createdById',
        interface: 'createdBy',
      });
      documents.setField('updatedBy', {
        type: 'belongsTo',
        target: 'users',
        foreignKey: 'updatedById',
        interface: 'updatedBy',
      });
      await documents.model.sync({ alter: true });
    });
    const state = () => ({ currentTenantId: 'B', currentRole: 'editor', currentUser: { id: userId } });
    it('creates an owned record with the real execution user in both audit fields', async () => {
      const job = await execute('create', { values: { name: 'Audited create' } }, state());
      expect(job.status, JSON.stringify(job.result)).toBe(EXECUTION_STATUS.RESOLVED);
      const actual = await get(job.result.id);
      expect(actual).toMatchObject({ name: 'Audited create', tenantId: 'B' });
      expect(String(actual.createdById)).toBe(String(userId));
      expect(String(actual.updatedById)).toBe(String(userId));
      expect(String(job.result.createdById)).toBe(String(userId));
    });
    it('updates only the modifier for a real execution user', async () => {
      const author = await app.db.getCollection('users').model.create({ nickname: 'Original audit author' });
      const original = await documents.repository.create({
        values: { name: 'Owned audited record', tenantId: 'B' },
        context: { state: { currentUser: { id: author.get('id') } } },
      });
      const job = await execute(
        'update',
        { filterByTk: original.get('id'), values: { name: 'Audited update' } },
        state(),
      );
      expect(job.status, JSON.stringify(job.result)).toBe(EXECUTION_STATUS.RESOLVED);
      const actual = await get(original.get('id'));
      expect(actual).toMatchObject({ name: 'Audited update', tenantId: 'B' });
      expect(String(actual.createdById)).toBe(String(author.get('id')));
      expect(String(actual.updatedById)).toBe(String(userId));
      expect(String(job.result.data[0].createdById)).toBe(String(author.get('id')));
      expect(String(job.result.data[0].updatedById)).toBe(String(userId));
    });
    it('keeps background execution audit fields empty when no user is supplied', async () => {
      const job = await execute('create', { values: { name: 'Background create' } });
      expect(job.status, JSON.stringify(job.result)).toBe(EXECUTION_STATUS.RESOLVED);
      expect(await get(job.result.id)).toMatchObject({
        name: 'Background create',
        tenantId: 'B',
        createdById: null,
        updatedById: null,
      });
    });
    it.each([
      { kind: 'create' as const, human: true },
      { kind: 'update' as const, human: true },
      { kind: 'create' as const, human: false },
      { kind: 'update' as const, human: false },
    ])(
      'uses the persisted actor for an audited $kind after another user resumes the execution: human=$human',
      async ({ kind, human }) => {
        const delay = await workflow.createNode({
          type: 'delay',
          config: { duration: 60000, endStatus: JOB_STATUS.RESOLVED },
        });
        const last = await workflow.createNode({
          type: kind,
          upstreamId: delay.id,
          config: {
            collection: source.collectionName,
            params: { ...(kind === 'update' ? { filterByTk: 1 } : {}), values: { name: 'Resumed audit' } },
          },
        });
        await delay.update({ downstreamId: last.id });
        await plugin.trigger(workflow, {}, { context: { state: human ? state() : { currentTenantId: 'B' } } });
        (plugin.instructions.get('delay') as DelayInstruction).unload();
        const [execution] = await workflow.getExecutions({ order: [['id', 'DESC']] });
        expect(execution.status).toBe(EXECUTION_STATUS.STARTED);
        const [pending] = await execution.getJobs();
        expect(pending.status).toBe(JOB_STATUS.PENDING);
        const transient = await app.db.getCollection('users').model.create({ nickname: 'Resuming operator' });
        const context = {
          state: { currentTenantId: 'C', currentRole: 'operator', currentUser: { id: transient.get('id') } },
        };
        const transaction = await app.db.sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE });
        try {
          const processor = plugin.createProcessor(execution, { context, transaction });
          await processor.resume(pending);
          expect(execution.status, JSON.stringify(processor.lastSavedJob?.result)).toBe(EXECUTION_STATUS.RESOLVED);
          await transaction.commit();
          const result = processor.lastSavedJob!.result;
          const actual = await get(kind === 'create' ? result.id : 1);
          expect(actual).toMatchObject({ name: 'Resumed audit', tenantId: 'B' });
          const expectedUser = human ? userId : null;
          expect(String(actual.updatedById)).toBe(String(expectedUser));
          expect(String(kind === 'create' ? result.updatedById : result.data[0].updatedById)).toBe(
            String(expectedUser),
          );
          expect(String(actual.createdById)).toBe(String(kind === 'create' ? expectedUser : null));
          expect(context.state.currentUser.id).toBe(transient.get('id'));
        } finally {
          if (!(transaction as Transaction & { finished?: string }).finished) await transaction.rollback();
        }
      },
    );
    it.each(
      (['create', 'update'] as const).flatMap((kind) => ['role', 'user', 'tenant'].map((field) => ({ kind, field }))),
    )('does not borrow a resuming operator $field for an automatic $kind execution', async ({ kind, field }) => {
      const config = baseConfig();
      config.rules = [
        {
          ...config.rules[0],
          subject:
            field === 'tenant'
              ? { type: 'constant', value: true }
              : {
                  type: 'compare',
                  operator: 'eq',
                  left: { type: 'context', path: field === 'role' ? 'role.name' : 'user.id' },
                  right: { type: 'literal', value: field === 'role' ? 'operator' : String(userId) },
                },
        },
      ];
      await saveConfig(config);
      const delay = await workflow.createNode({
        type: 'delay',
        config: { duration: 60000, endStatus: JOB_STATUS.RESOLVED },
      });
      const last = await workflow.createNode({
        type: kind,
        upstreamId: delay.id,
        config: {
          collection: source.collectionName,
          params: {
            ...(kind === 'update' ? { filterByTk: 1 } : {}),
            values: { ...(kind === 'create' ? { id: 800 } : {}), name: 'Must not borrow role' },
          },
        },
      });
      await delay.update({ downstreamId: last.id });
      await plugin.trigger(workflow, {}, { context: { state: field === 'tenant' ? {} : { currentTenantId: 'B' } } });
      (plugin.instructions.get('delay') as DelayInstruction).unload();
      const [execution] = await workflow.getExecutions({ order: [['id', 'DESC']] });
      expect(execution.get('authContext')).toBeNull();
      expect(execution.status).toBe(EXECUTION_STATUS.STARTED);
      const [pending] = await execution.getJobs();
      const transaction = await app.db.sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE });
      try {
        const processor = plugin.createProcessor(execution, {
          context: {
            state: {
              currentTenantId: 'B',
              currentRole: 'operator',
              ...(field === 'user' ? { currentUserId: userId } : {}),
            },
          },
          transaction,
        });
        await processor.resume(pending);
        expect(execution.status, JSON.stringify(processor.lastSavedJob?.result)).toBe(EXECUTION_STATUS.ERROR);
        expect(processor.lastSavedJob!.result.message).toMatch(/context|unavailable|authoriz|scope/i);
        // The inherited transaction belongs to this caller, including a rejected create.
        await transaction.rollback();
        const actual = await documents.model.findByPk(kind === 'create' ? 800 : 1, { hooks: false });
        if (kind === 'create') expect(actual).toBeNull();
        else expect(actual.get('name')).toBe('Owned');
      } finally {
        if (!(transaction as Transaction & { finished?: string }).finished) await transaction.rollback();
      }
    });
    it.each(['create', 'update'] as const)(
      'uses the retrying actor for a new audited %s execution without changing the original tenant',
      async (kind) => {
        const original = await execute(
          kind,
          { ...(kind === 'update' ? { filterByTk: 1 } : {}), values: { name: 'Retry audit' } },
          state(),
        );
        expect(original.status).toBe(EXECUTION_STATUS.RESOLVED);
        const [originalExecution] = await workflow.getExecutions({ order: [['id', 'DESC']] });
        const operator = await app.db.getCollection('users').model.create({ nickname: 'Retrying operator' });
        const config = baseConfig();
        config.rules = [
          {
            ...config.rules[0],
            subject: {
              type: 'compare',
              operator: 'eq',
              left: { type: 'context', path: 'user.id' },
              right: { type: 'literal', value: String(operator.get('id')) },
            },
          },
        ];
        await saveConfig(config);
        const transaction = await app.db.sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE });
        try {
          const ctx = {
            app,
            db: app.db,
            tego: { pm: { get: () => plugin }, logger: app.logger },
            transaction,
            state: {
              currentTenantId: 'H',
              currentTenancyMode: 'tenantInherited',
              currentTenantDescendantIds: ['B', 'C'],
              currentRole: 'operator',
              currentUser: { id: operator.get('id') },
            },
            action: { resourceName: 'executions', actionName: 'retry', params: { filterByTk: originalExecution.id } },
            t: (message: string) => message,
            throw(status: number, message?: string) {
              throw Object.assign(new Error(message ?? String(status)), { status });
            },
          } as unknown as Context;
          await retryExecution(ctx, async () => {});
          const [execution] = await workflow.getExecutions({ transaction, order: [['id', 'DESC']] });
          const [job] = await execution.getJobs({ transaction });
          expect(execution.status, JSON.stringify(job.result)).toBe(EXECUTION_STATUS.RESOLVED);
          expect(execution.id).not.toBe(originalExecution.id);
          expect(execution.get('tenantContext')).toMatchObject({ currentTenantId: 'B' });
          expect(execution.get('authContext')).toMatchObject({ currentUserId: operator.get('id') });
          await transaction.commit();
          const actual = await get(kind === 'create' ? job.result.id : 1);
          expect(actual).toMatchObject({ name: 'Retry audit', tenantId: 'B' });
          expect(String(actual.updatedById)).toBe(String(operator.get('id')));
          expect(String(actual.createdById)).toBe(String(kind === 'create' ? operator.get('id') : null));
          await originalExecution.reload();
          expect(originalExecution.get('authContext')).toMatchObject({ currentUserId: userId });
        } finally {
          if (!(transaction as Transaction & { finished?: string }).finished) await transaction.rollback();
        }
      },
    );
  });
});

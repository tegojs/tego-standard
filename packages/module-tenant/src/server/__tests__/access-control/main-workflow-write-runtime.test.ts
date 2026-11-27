import { createMockServer, type MockServer } from '@tachybase/test';

import { EXECUTION_STATUS, JOB_STATUS } from '../../../../../module-workflow/src/server/constants';
import type DelayInstruction from '../../../../../module-workflow/src/server/features/delay/DelayInstruction';
import UpdateOrCreateInstruction from '../../../../../module-workflow/src/server/instructions/UpdateOrCreateInstruction';
import type WorkflowPlugin from '../../../../../module-workflow/src/server/Plugin';
import { accessConfigHistory } from '../../access-control/config-history';
import type { AccessCollectionIdentity } from '../../access-control/config-store';
import { AccessMainWorkflowWriteRuntime } from '../../access-control/main-workflow-write-runtime';
import type { AccessWorkflowScalarWriteRequest } from '../../access-control/workflow-scalar-write';
import { configFor, ownerCondition } from './fixtures';

describe('explicit main-source workflow write runtime', () => {
  let app: MockServer;
  let plugin: WorkflowPlugin;
  let runtime: AccessMainWorkflowWriteRuntime;
  let source: AccessCollectionIdentity;
  let selected: AccessCollectionIdentity[];
  let workflow;
  let failAfterUpdate: boolean;
  let activeWriteRequest: AccessWorkflowScalarWriteRequest | undefined;
  let upsertGuardMode: 'boundary' | 'async' | 'invalid';

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
            createResolver: (request) => runtime.resolveCreate(request, selected),
            updateResolver: (request) => {
              activeWriteRequest = request;
              return runtime.resolveUpdate(request, selected);
            },
            destroyResolver: (request) => runtime.resolveDestroy(request, selected),
            updateOrCreateGuard: (request) => {
              if (upsertGuardMode === 'async') return Promise.resolve();
              if (upsertGuardMode === 'invalid') return true;
              runtime.assertUpdateOrCreateBoundary(request, selected);
            },
            createTransactionPlanner: (target) => runtime.plan(target, selected),
            updateTransactionPlanner: (target) => runtime.plan(target, selected),
            destroyTransactionPlanner: (target) => runtime.plan(target, selected),
          },
        ],
      ],
    });
    plugin = app.pm.get('workflow') as WorkflowPlugin;
    const stored = await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: 'runtimeWriteDocuments',
        tenancy: 'tenantScoped',
        fields: [
          { name: 'name', type: 'string' },
          { name: 'amount', type: 'integer' },
          { name: 'tenantId', type: 'string' },
        ],
      },
    });
    source = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName: 'runtimeWriteDocuments' };
    await app.db.getCollection(source.collectionName).model.sync();
    await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: 'legacyRuntimeWriteSources',
        tenancy: 'tenantScoped',
        fields: [
          { name: 'name', type: 'string' },
          { name: 'tenantId', type: 'string' },
          { name: 'document', type: 'belongsTo', target: source.collectionName, foreignKey: 'documentId' },
        ],
      },
    });
    await app.db
      .collection({
        name: 'tenants',
        timestamps: false,
        autoGenId: false,
        fields: [
          { name: 'id', type: 'string', primaryKey: true },
          { name: 'enabled', type: 'boolean' },
        ],
      })
      .model.sync();
    await app.db.getCollection('tenants').model.bulkCreate(['B', 'C', 'H'].map((id) => ({ id, enabled: true })));
    await app.db.collection(accessConfigHistory).model.sync();
    runtime = new AccessMainWorkflowWriteRuntime(app, (request) => plugin.captureDataOperationAuthority(request));
    plugin.options.updateOrCreateGuard = () => {
      throw new Error('Startup upsert guard was not captured');
    };
    const config = configFor({
      type: 'all',
      children: [
        ownerCondition,
        {
          type: 'compare',
          operator: 'gte',
          left: { type: 'field', path: 'amount' },
          right: { type: 'literal', value: 100 },
        },
      ],
    });
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
    await runtime.registry.store.save(source, { ...config, revision: 0 }, { userId: 28 });
    app.db.on('runtimeWriteDocuments.afterUpdate', () => {
      if (failAfterUpdate) throw new Error('Business workflow update failed');
    });
  });

  beforeEach(async () => {
    selected = [{ ...source }];
    failAfterUpdate = false;
    activeWriteRequest = undefined;
    upsertGuardMode = 'boundary';
    const model = app.db.getCollection(source.collectionName).model;
    await model.destroy({ where: {}, hooks: false });
    await model.bulkCreate([
      { id: 1, name: 'Visible', amount: 10, tenantId: 'H' },
      { id: 2, name: 'Owned B', amount: 200, tenantId: 'B' },
      { id: 3, name: 'Owned C', amount: 300, tenantId: 'C' },
      { id: 4, name: 'Excluded B', amount: 5, tenantId: 'B' },
    ]);
    const legacy = app.db.getCollection('legacyRuntimeWriteSources').model;
    await legacy.destroy({ where: {}, hooks: false });
    await legacy.bulkCreate([{ id: 1, name: 'Legacy B', tenantId: 'B', documentId: null }]);
    workflow = await app.db.getRepository('workflows').create({
      values: {
        title: 'Explicit access write selection',
        type: 'collection',
        sync: true,
        enabled: true,
        config: { collection: 'runtimeWriteEvents', mode: 1 },
      },
    });
  });
  afterEach(async () => {
    await workflow?.update({ enabled: false });
  });
  afterAll(async () => {
    await app?.destroy();
  });

  async function execute(type: 'create' | 'update' | 'destroy', params: object, tenant: string | null = 'B') {
    await workflow.createNode({ type, config: { collection: source.collectionName, params } });
    return run(tenant);
  }
  async function run(tenant: string | null = 'B') {
    await plugin.trigger(workflow, {}, { context: { state: { currentTenantId: tenant } } });
    const [execution] = await workflow.getExecutions({ order: [['id', 'DESC']] });
    const [job] = await execution.getJobs();
    return { execution, job };
  }
  async function rows() {
    return (await app.db.getCollection(source.collectionName).model.findAll({ order: [['id', 'ASC']] })).map((row) => ({
      id: row.get('id'),
      name: row.get('name'),
      amount: row.get('amount'),
      tenantId: row.get('tenantId'),
    }));
  }

  it.each([false, true])('reloads committed rules before a persisted delayed update (revoke G: %s)', async (revoke) => {
    const original = (await runtime.registry.store.read(source))!;
    const first = await workflow.createNode({
      type: 'update',
      config: { collection: source.collectionName, params: { filterByTk: 2, values: { name: 'Before suspension' } } },
    });
    const delay = await workflow.createNode({
      type: 'delay',
      config: { duration: 60000, endStatus: JOB_STATUS.RESOLVED },
      upstreamId: first.id,
    });
    const last = await workflow.createNode({
      type: 'update',
      config: { collection: source.collectionName, params: { filterByTk: 2, values: { name: 'After resume' } } },
      upstreamId: delay.id,
    });
    await first.update({ downstreamId: delay.id });
    await delay.update({ downstreamId: last.id });
    const instruction = plugin.instructions.get('delay') as DelayInstruction;
    try {
      const { execution } = await run();
      instruction.unload();
      expect(execution.status).toBe(EXECUTION_STATUS.STARTED);
      expect(execution.tenantId).toBe('B');
      expect(execution.tenantContext.currentTenantId).toBe('B');
      const pending = await execution.getJobs({ order: [['id', 'ASC']] });
      expect(pending.map((job) => job.status)).toEqual([JOB_STATUS.RESOLVED, JOB_STATUS.PENDING]);
      expect(pending[0].result.data).toHaveLength(1);
      expect(pending[0].result.data[0]).toMatchObject({ id: 2, name: 'Before suspension', amount: 200, tenantId: 'B' });
      const beforeResume = await rows();
      await runtime.registry.store.save(source, { ...original, rules: revoke ? [] : original.rules }, { userId: 28 });
      await delay.update({ config: { duration: 0, endStatus: JOB_STATUS.RESOLVED } });
      await instruction.load();
      await vi.waitFor(
        async () => {
          await execution.reload();
          expect(execution.status).toBe(revoke ? EXECUTION_STATUS.ERROR : EXECUTION_STATUS.RESOLVED);
        },
        { timeout: 10000, interval: 50 },
      );
      const resumed = await execution.getJobs({ order: [['id', 'ASC']] });
      expect(resumed.map((job) => job.status)).toEqual([
        JOB_STATUS.RESOLVED,
        JOB_STATUS.RESOLVED,
        revoke ? JOB_STATUS.ERROR : JOB_STATUS.RESOLVED,
      ]);
      expect(execution.tenantId).toBe('B');
      expect(await rows()).toEqual(
        beforeResume.map((row) => (row.id === 2 && !revoke ? { ...row, name: 'After resume' } : row)),
      );
      if (!revoke) {
        expect(resumed[2].result.data).toHaveLength(1);
        expect(resumed[2].result.data[0]).toMatchObject({ id: 2, name: 'After resume', amount: 200, tenantId: 'B' });
      } else expect(resumed[2].result.message).toBe('Record is unavailable for this mutation');
    } finally {
      instruction.unload();
      const current = (await runtime.registry.store.read(source))!;
      await runtime.registry.store.save(source, { ...original, revision: current.revision }, { userId: 28 });
      await workflow.update({ enabled: false });
      await instruction.load();
    }
  });

  it('updates only G rows rather than all rows owned by the active tenant', async () => {
    const { execution, job } = await execute('update', { values: { name: 'Updated' } });
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    expect(job.result.length).toBe(1);
    expect(await rows()).toEqual([
      { id: 1, name: 'Visible', amount: 10, tenantId: 'H' },
      { id: 2, name: 'Updated', amount: 200, tenantId: 'B' },
      { id: 3, name: 'Owned C', amount: 300, tenantId: 'C' },
      { id: 4, name: 'Excluded B', amount: 5, tenantId: 'B' },
    ]);
  });

  it('deletes only G rows while preserving visibility-only and excluded same-tenant rows', async () => {
    const { execution, job } = await execute('destroy', {});
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result).toBe(1);
    expect((await rows()).map((row) => row.id)).toEqual([1, 3, 4]);
  });

  it('rolls back a create that does not satisfy G after persistence', async () => {
    const before = await rows();
    const { execution, job } = await execute('create', { values: { name: 'Rejected', amount: 5 } });
    expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.status).toBe(JOB_STATUS.ERROR);
    expect(await rows()).toEqual(before);
  });

  it.each(['update', 'create'] as const)('does not bypass selected G by changing %s to upsert', async (type) => {
    const before = await rows();
    const node = await workflow.createNode({
      type,
      config: {
        collection: source.collectionName,
        params: {
          filterByTk: type === 'update' ? 4 : 999,
          values: { name: 'Upsert outside G', amount: 5 },
        },
      },
    });
    const control = await run();
    expect(control.execution.status).toBe(EXECUTION_STATUS.ERROR);
    expect(control.job.status).toBe(JOB_STATUS.ERROR);
    expect(await rows()).toEqual(before);

    await node.update({ type: 'updateorcreate' });
    const { execution, job } = await run();
    expect({ status: execution.status, rows: await rows() }).toEqual({
      status: EXECUTION_STATUS.ERROR,
      rows: before,
    });
    expect(job.status).toBe(JOB_STATUS.ERROR);
  });

  it.each([true, false])('preserves unselected upsert with a configured guard (existing: %s)', async (existing) => {
    selected = [];
    await workflow.createNode({
      type: 'updateorcreate',
      config: {
        collection: source.collectionName,
        params: { filterByTk: existing ? 4 : 999, values: { name: 'Legacy upsert', amount: 5 } },
      },
    });
    const { execution, job } = await run();
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    expect((await rows()).find((row) => row.name === 'Legacy upsert')).toEqual({
      id: existing ? 4 : 5,
      name: 'Legacy upsert',
      amount: 5,
      tenantId: 'B',
    });
    expect(await rows()).toHaveLength(existing ? 4 : 5);
  });

  it('rejects a non-function upsert guard at instruction installation', () => {
    expect(() => new UpdateOrCreateInstruction(plugin, false as never)).toThrow(/guard must be a function/);
  });

  it('rejects a selected G upsert before preparing attachment resources', async () => {
    const before = await rows();
    const field = app.db.getCollection(source.collectionName).getField('name');
    const original = field.options.interface;
    field.options.interface = 'attachment';
    try {
      await workflow.createNode({
        type: 'updateorcreate',
        config: {
          collection: source.collectionName,
          params: { filterByTk: 2, values: { name: 'data:invalid', amount: 200 } },
        },
      });
      const { execution, job } = await run();
      expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
      expect(job.status).toBe(JOB_STATUS.ERROR);
      expect(job.result.message).toMatch(/Selected workflow upserts require a dedicated adapter/);
      expect(await rows()).toEqual(before);
    } finally {
      if (original === undefined) delete field.options.interface;
      else field.options.interface = original;
    }
  });

  it.each(['async', 'invalid'] as const)('does not proceed after an %s upsert guard result', async (mode) => {
    selected = [];
    upsertGuardMode = mode;
    const before = await rows();
    await workflow.createNode({
      type: 'updateorcreate',
      config: {
        collection: source.collectionName,
        params: { filterByTk: 2, values: { name: 'Must not persist' } },
      },
    });
    const { execution, job } = await run();
    expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.status).toBe(JOB_STATUS.ERROR);
    expect(job.result.message).toMatch(/guard must return undefined synchronously/);
    expect(await rows()).toEqual(before);
  });

  it.each(['foreignKey', 'reference', 'filter', 'appends'] as const)(
    'rejects legacy upsert crossing a selected target through %s',
    async (shape) => {
      const before = await rows();
      const legacy = app.db.getCollection('legacyRuntimeWriteSources').model;
      const legacyBefore = (await legacy.findAll()).map((row) => row.toJSON());
      await workflow.createNode({
        type: 'updateorcreate',
        config: {
          collection: 'legacyRuntimeWriteSources',
          params: {
            filterByTk: 1,
            values: {
              name: 'Must not persist',
              ...(shape === 'foreignKey' ? { documentId: 2 } : {}),
              ...(shape === 'reference' ? { document: { id: 2 } } : {}),
            },
            ...(shape === 'filter' ? { filter: { 'document.name': 'Owned B' } } : {}),
            ...(shape === 'appends' ? { appends: ['document'] } : {}),
          },
        },
      });
      const { execution, job } = await run();
      expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
      expect(job.status).toBe(JOB_STATUS.ERROR);
      expect(job.result.message).toMatch(/selected access collections/);
      expect((await legacy.findAll()).map((row) => row.toJSON())).toEqual(legacyBefore);
      expect(await rows()).toEqual(before);
    },
  );

  it.each(['CASCADE', 'SET NULL'] as const)(
    'rejects a legacy workflow destroy with %s writes into a selected target',
    async (onDelete) => {
      const suffix = onDelete === 'CASCADE' ? 'cascade' : 'null';
      const parentName = `legacyWorkflowDelete_${suffix}`;
      const childName = `protectedWorkflowDelete_${suffix}`;
      await app.db.getRepository('collections').create({
        context: {},
        values: {
          name: parentName,
          tenancy: 'tenantScoped',
          timestamps: false,
          createdBy: false,
          updatedBy: false,
          fields: [
            { name: 'name', type: 'string' },
            { name: 'tenantId', type: 'string' },
          ],
        },
      });
      const child = await app.db.getRepository('collections').create({
        context: {},
        values: {
          name: childName,
          tenancy: 'tenantScoped',
          timestamps: false,
          createdBy: false,
          updatedBy: false,
          fields: [
            { name: 'tenantId', type: 'string' },
            { name: 'parent', type: 'belongsTo', target: parentName, foreignKey: 'parentId', onDelete },
          ],
        },
      });
      const childIdentity = { dataSourceKey: 'main', collectionKey: child.get('key'), collectionName: childName };
      await runtime.registry.store.save(
        childIdentity,
        { ...configFor(ownerCondition), revision: 0, rules: [] },
        { userId: 28 },
      );
      const parents = app.db.getCollection(parentName).model;
      const children = app.db.getCollection(childName).model;
      await parents.bulkCreate([
        { id: 1, tenantId: 'B', name: 'Unselected baseline' },
        { id: 2, tenantId: 'B', name: 'Selected child' },
      ]);
      await children.bulkCreate([
        { id: 1, tenantId: 'C', parentId: 1 },
        { id: 2, tenantId: 'C', parentId: 2 },
      ]);
      selected = [childIdentity];
      const node = await workflow.createNode({
        type: 'destroy',
        config: { collection: childName, params: { filterByTk: 2 } },
      });
      const direct = await run();
      expect(direct.execution.status).toBe(EXECUTION_STATUS.ERROR);
      expect(direct.job.status).toBe(JOB_STATUS.ERROR);
      expect((await children.findByPk(2))?.get()).toMatchObject({ id: 2, tenantId: 'C', parentId: 2 });
      selected = [{ ...source }];
      await node.update({ config: { collection: parentName, params: { filterByTk: 1 } } });
      const baseline = await run();
      expect(baseline.execution.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(baseline.job.status).toBe(JOB_STATUS.RESOLVED);
      expect(baseline.job.result).toBe(1);
      expect(await parents.findByPk(1)).toBeNull();
      const changed = await children.findByPk(1);
      if (onDelete === 'CASCADE') expect(changed).toBeNull();
      else expect(changed?.get()).toMatchObject({ id: 1, parentId: null, tenantId: 'C' });
      selected = [childIdentity];
      await node.update({ config: { collection: parentName, params: { filterByTk: 2 } } });
      const beforeParents = (await parents.findAll({ order: [['id', 'ASC']] })).map((row) => row.get());
      const beforeChildren = (await children.findAll({ order: [['id', 'ASC']] })).map((row) => row.get());
      const rejected = await run();
      expect({
        status: rejected.execution.status,
        parents: (await parents.findAll({ order: [['id', 'ASC']] })).map((row) => row.get()),
        children: (await children.findAll({ order: [['id', 'ASC']] })).map((row) => row.get()),
      }).toEqual({ status: EXECUTION_STATUS.ERROR, parents: beforeParents, children: beforeChildren });
      expect(rejected.job.status).toBe(JOB_STATUS.ERROR);
      expect(rejected.job.result.message).toMatch(/Legacy cascaded writes/);
      selected = [{ ...source }];
      const restored = await run();
      expect(restored.execution.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(restored.job.status).toBe(JOB_STATUS.RESOLVED);
      expect(restored.job.result).toBe(1);
      expect(await parents.findByPk(2)).toBeNull();
      const restoredChild = await children.findByPk(2);
      if (onDelete === 'CASCADE') expect(restoredChild).toBeNull();
      else expect(restoredChild?.get()).toMatchObject({ id: 2, parentId: null, tenantId: 'C' });
    },
  );

  it('keeps unselected configured tables on the existing workflow update path', async () => {
    selected = [];
    const { execution } = await execute('update', { filterByTk: 4, values: { name: 'Legacy update' } });
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect((await rows())[3]).toEqual({ id: 4, name: 'Legacy update', amount: 5, tenantId: 'B' });
  });

  it('creates a G record under the actual execution tenant', async () => {
    const { execution, job } = await execute('create', { values: { name: 'Created', amount: 250 } });
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result).toMatchObject({ name: 'Created', amount: 250, tenantId: 'B' });
    expect((await rows()).find((row) => row.name === 'Created')).toMatchObject({ amount: 250, tenantId: 'B' });
  });

  it('rejects a supplied different owner instead of changing the execution tenant', async () => {
    const before = await rows();
    const { execution, job } = await execute('create', { values: { name: 'Rejected', amount: 250, tenantId: 'C' } });
    expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.status).toBe(JOB_STATUS.ERROR);
    expect(await rows()).toEqual(before);
  });

  it.each(['create', 'update', 'destroy'] as const)(
    'rejects a mismatched persistent key before %s without legacy retry',
    async (type) => {
      const before = await rows();
      selected = [{ ...source, collectionKey: 'wrong-persistent-key' }];
      const params =
        type === 'create'
          ? { values: { name: 'Unexpected', amount: 200 } }
          : type === 'update'
            ? { filterByTk: 2, values: { name: 'Unexpected' } }
            : { filterByTk: 2 };
      const { execution, job } = await execute(type, params);
      expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
      expect(job.status).toBe(JOB_STATUS.ERROR);
      expect(await rows()).toEqual(before);
    },
  );

  it.each(['create', 'update', 'destroy'] as const)(
    'rejects selected %s without a trusted execution tenant',
    async (type) => {
      const before = await rows();
      const params =
        type === 'create'
          ? { values: { name: 'Unexpected', amount: 200 } }
          : type === 'update'
            ? { filterByTk: 2, values: { name: 'Unexpected' } }
            : { filterByTk: 2 };
      const { execution, job } = await execute(type, params, null);
      expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
      expect(job.status).toBe(JOB_STATUS.ERROR);
      expect(await rows()).toEqual(before);
    },
  );

  it.each((['update', 'destroy'] as const).flatMap((type) => [1, 4].map((id) => ({ type, id }))))(
    'does not let explicit $type keys bypass G for record $id',
    async ({ type, id }) => {
      const before = await rows();
      const { execution, job } = await execute(type, {
        filterByTk: id,
        ...(type === 'update' ? { values: { name: 'Unexpected' } } : {}),
      });
      expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
      expect(job.status).toBe(JOB_STATUS.ERROR);
      expect(await rows()).toEqual(before);
    },
  );

  it('reads current rules for the next execution instead of retaining a prior write scope', async () => {
    const original = (await runtime.registry.store.read(source))!;
    const first = await execute('update', { values: { name: 'Allowed update' } });
    expect(first.execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(first.job.result.length).toBe(1);
    const before = await rows();
    try {
      await runtime.registry.store.save(source, { ...original, rules: [] }, { userId: 28 });
      const { execution, job } = await run();
      expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(job.result).toEqual({ length: 0, data: [] });
      expect(await rows()).toEqual(before);
    } finally {
      const current = (await runtime.registry.store.read(source))!;
      await runtime.registry.store.save(source, { ...original, revision: current.revision }, { userId: 28 });
    }
  });

  it('rolls back a selected G update when the actual business afterUpdate hook fails', async () => {
    const before = await rows();
    failAfterUpdate = true;
    const { execution, job } = await execute('update', { filterByTk: 2, values: { name: 'Unexpected' } });
    expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.status).toBe(JOB_STATUS.ERROR);
    expect(await rows()).toEqual(before);
  });

  it('rejects write values changed while persistent table discovery is in flight', async () => {
    const before = await rows();
    const metadata = app.db.getCollection('collections').model;
    const original = metadata.findAll;
    let changed = false;
    const delivery = vi.spyOn(metadata, 'findAll').mockImplementation(async function (options) {
      const result = await original.call(this, options);
      if (activeWriteRequest && !changed) {
        changed = true;
        (activeWriteRequest.params as { values: { name: string } }).values.name = 'Changed after selection';
      }
      return result;
    });
    try {
      const { execution, job } = await execute('update', { filterByTk: 2, values: { name: 'Selected value' } });
      expect(changed).toBe(true);
      expect({ status: execution.status, rows: await rows() }).toEqual({
        status: EXECUTION_STATUS.ERROR,
        rows: before,
      });
      expect(job.status).toBe(JOB_STATUS.ERROR);
    } finally {
      delivery.mockRestore();
    }
  });

  it('keeps legacy references when the target is not selected', async () => {
    selected = [];
    await workflow.createNode({
      type: 'update',
      config: {
        collection: 'legacyRuntimeWriteSources',
        params: { filterByTk: 1, values: { documentId: 2 } },
      },
    });
    const { execution, job } = await run();
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    expect((await app.db.getCollection('legacyRuntimeWriteSources').model.findByPk(1))?.get('documentId')).toBe(2);
  });

  it.each(
    (['create', 'update'] as const).flatMap((action) =>
      ['foreignKey', 'reference'].map((shape) => ({ action, shape })),
    ),
  )('rejects legacy workflow $action references through $shape to a selected target', async ({ action, shape }) => {
    const original = (await runtime.registry.store.read(source))!;
    const legacy = app.db.getCollection('legacyRuntimeWriteSources').model;
    const snapshot = async () =>
      (await legacy.findAll({ order: [['id', 'ASC']] })).map((row) => ({
        id: row.get('id'),
        documentId: row.get('documentId'),
        tenantId: row.get('tenantId'),
      }));
    const before = await snapshot();
    try {
      await runtime.registry.store.save(source, { ...original, rules: [] }, { userId: 28 });
      await workflow.createNode({
        type: action,
        config: {
          collection: 'legacyRuntimeWriteSources',
          params: {
            ...(action === 'update' ? { filterByTk: 1 } : {}),
            values: shape === 'foreignKey' ? { documentId: 2 } : { document: 2 },
          },
        },
      });
      const { execution, job } = await run();
      expect({ status: execution.status, sources: await snapshot() }).toEqual({
        status: EXECUTION_STATUS.ERROR,
        sources: before,
      });
      expect(job.status).toBe(JOB_STATUS.ERROR);
    } finally {
      const current = (await runtime.registry.store.read(source))!;
      await runtime.registry.store.save(source, { ...original, revision: current.revision }, { userId: 28 });
    }
  });
});

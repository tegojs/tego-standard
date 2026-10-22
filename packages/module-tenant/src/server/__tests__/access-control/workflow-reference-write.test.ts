import { createMockServer, type MockServer } from '@tachybase/test';
import { ACL, Transaction } from '@tego/server';

import { EXECUTION_STATUS } from '../../../../../module-workflow/src/server/constants';
import type WorkflowPlugin from '../../../../../module-workflow/src/server/Plugin';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessConfigHistory } from '../../access-control/config-history';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { AccessWorkflowRootHandler } from '../../access-control/workflow-root-handler';
import { AccessWorkflowWriteTransactionPlanner } from '../../access-control/workflow-write-transaction';
import { isolatedPostgresDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

describe.runIf(!!postgresUrl)('configured workflow single-value reference writes', () => {
  let app: MockServer;
  let plugin: WorkflowPlugin;
  let adapter: AccessAclScopeAdapter;
  let store: AccessConfigStore;
  let handler: AccessWorkflowRootHandler;
  let planner: AccessWorkflowWriteTransactionPlanner;
  let planning: boolean;
  let planningCalls: number;
  let actualIsolation: string | undefined;
  let documents;
  let projects;
  let source;
  let target;
  let workflow;
  let request;
  let tamper: boolean;
  let failLater: boolean;
  let release: boolean;
  const identity = (collection) => (collection === documents ? source : collection === projects ? target : undefined);
  const targetConfig = () => ({
    ...configFor(ownerCondition),
    rules: [
      ...configFor(ownerCondition).rules,
      {
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
        id: 'visible-target',
      },
    ],
  });

  beforeAll(async () => {
    const checked = isolatedPostgresDatabase(postgresUrl!);
    const database = checked.options;
    await checked.close();
    app = await createMockServer({
      database,
      plugins: [
        'error-handler',
        'collection',
        'user',
        [
          'workflow',
          {
            createTransactionPlanner: (target) => {
              planningCalls++;
              return planner.plan(target);
            },
            updateTransactionPlanner: (target) => {
              planningCalls++;
              return planner.plan(target);
            },
            createResolver: () => async (input) => {
              request = input;
              if (planning) {
                const [rows] = await app.db.sequelize.query(
                  "SELECT current_setting('transaction_isolation') AS transaction_isolation",
                  {
                    transaction: input.transaction,
                  },
                );
                actualIsolation = (rows[0] as { transaction_isolation: string }).transaction_isolation;
              }
              return handler.create(input);
            },
            updateResolver: () => async (input) => {
              request = input;
              if (planning) {
                const [rows] = await app.db.sequelize.query(
                  "SELECT current_setting('transaction_isolation') AS transaction_isolation",
                  {
                    transaction: input.transaction,
                  },
                );
                actualIsolation = (rows[0] as { transaction_isolation: string }).transaction_isolation;
              }
              return handler.update(input);
            },
          },
        ],
      ],
    });
    plugin = app.pm.get('workflow') as WorkflowPlugin;
    const repo = app.db.getRepository('collections');
    const projectRow = await repo.create({
      context: {},
      values: {
        name: 'workflowReferenceProjects',
        fields: [
          { name: 'name', type: 'string' },
          { name: 'tenantId', type: 'string' },
        ],
      },
    });
    projects = app.db.getCollection('workflowReferenceProjects');
    await projects.model.sync();
    const documentRow = await repo.create({
      context: {},
      values: {
        name: 'workflowReferenceDocuments',
        fields: [
          { name: 'name', type: 'string' },
          { name: 'tenantId', type: 'string' },
          { name: 'project', type: 'belongsTo', target: projects.name, foreignKey: 'projectId' },
          { name: 'alternative', type: 'belongsTo', target: projects.name, foreignKey: 'alternativeId' },
          { name: 'parent', type: 'belongsTo', target: 'workflowReferenceDocuments', foreignKey: 'parentId' },
        ],
      },
    });
    documents = app.db.getCollection('workflowReferenceDocuments');
    await documents.model.sync();
    source = { dataSourceKey: 'main', collectionKey: documentRow.get('key'), collectionName: documents.name };
    target = { dataSourceKey: 'main', collectionKey: projectRow.get('key'), collectionName: projects.name };
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
    const key = (collection) => accessCollectionKey(identity(collection)!);
    store = new AccessConfigStore(app.db, (source) =>
      resolveModelMetadata(app.db.getCollection(source.collectionName), { resolveCollectionKey: key }),
    );
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, app.db);
    planner = new AccessWorkflowWriteTransactionPlanner(app.db, store, identity);
    handler = new AccessWorkflowRootHandler(
      app.db,
      adapter,
      new AccessQueryService(app.db, adapter, key),
      identity,
      (input) => plugin.captureDataOperationAuthority(input),
    );
    app.db.on(`${documents.name}.afterUpdate`, async (record, options) => {
      if (failLater && record.getDataValue('id') === 3) throw new Error('later reference update failed');
      if (tamper)
        await documents.model.update(
          { projectId: 102 },
          { where: { id: record.getDataValue('id') }, transaction: options.transaction, hooks: false },
        );
      if (release) adapter.release(request.context);
    });
    app.db.on(`${documents.name}.afterCreate`, async (record, options) => {
      if (tamper)
        await documents.model.update(
          { projectId: 102 },
          { where: { id: record.getDataValue('id') }, transaction: options.transaction, hooks: false },
        );
      if (release) adapter.release(request.context);
    });
  });
  async function save(identity, config) {
    const current = await store.read(identity);
    await store.save(identity, { ...config, revision: current?.revision ?? 0 }, { userId: 28 });
  }
  beforeEach(async () => {
    tamper = failLater = release = false;
    planning = false;
    planningCalls = 0;
    actualIsolation = undefined;
    request = undefined;
    await save(source, configFor(ownerCondition));
    await save(target, targetConfig());
    await documents.model.destroy({ where: {}, hooks: false });
    await projects.model.destroy({ where: {}, hooks: false });
    await projects.model.bulkCreate([
      { id: 101, name: 'Visible', tenantId: 'H' },
      { id: 102, name: 'Hidden', tenantId: 'C' },
      { id: 103, name: 'Owned', tenantId: 'B' },
      { id: 104, name: 'Legacy', tenantId: null },
    ]);
    await documents.model.bulkCreate([
      { id: 1, name: 'First', tenantId: 'B', projectId: 101 },
      { id: 2, name: 'Other', tenantId: 'C', projectId: 102 },
      { id: 3, name: 'Second', tenantId: 'B', projectId: 103 },
      { id: 5, name: 'Legacy', tenantId: null },
    ]);
    workflow = await app.db.getRepository('workflows').create({
      values: {
        title: 'Reference write',
        type: 'collection',
        enabled: true,
        sync: true,
        config: { collection: 'referenceEvents', mode: 1 },
      },
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await workflow?.update({ enabled: false });
  });
  afterAll(async () => {
    if (app) {
      const tables = Object.values(app.db.sequelize.models).map((model) => model.getTableName());
      await app.destroy();
      const cleanup = isolatedPostgresDatabase(postgresUrl!);
      try {
        for (const table of tables) await cleanup.sequelize.getQueryInterface().dropTable(table, { cascade: true });
      } finally {
        await cleanup.close();
      }
    }
  });
  const get = async (id = 1) => (await documents.model.findByPk(id))?.get({ plain: true });
  async function execute(kind: 'create' | 'update', params: object, serializable: boolean | null = true) {
    await workflow.createNode({ type: kind, config: { collection: documents.name, params } });
    const transaction =
      serializable === null
        ? undefined
        : await app.db.sequelize.transaction({
            isolationLevel: serializable
              ? Transaction.ISOLATION_LEVELS.SERIALIZABLE
              : Transaction.ISOLATION_LEVELS.READ_COMMITTED,
          });
    try {
      await plugin.trigger(workflow, {}, { transaction, context: { state: { currentTenantId: 'B' } } });
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

  describe('node-owned transactions planned from written fields', () => {
    it.each([
      ['create', 'project', 101],
      ['update', 'project', 101],
      ['create', 'project', null],
      ['update', 'project', null],
      ['create', 'parent', 1],
      ['update', 'parent', 1],
    ] as const)('plans %s with %s = %s using real serializable isolation', async (kind, field, key) => {
      planning = true;
      const job = await execute(
        kind,
        {
          ...(kind === 'update' ? { filterByTk: 3 } : {}),
          values: { ...(kind === 'create' ? { id: 100 } : {}), [field]: key },
        },
        null,
      );
      expect(job.status, job.result?.stack).toBe(EXECUTION_STATUS.RESOLVED);
      expect(planningCalls).toBe(1);
      expect(actualIsolation).toBe('serializable');
      expect((request.transaction as Transaction & { finished?: string }).finished).toBe('commit');
      expect((await get(kind === 'create' ? 100 : 3))[field === 'parent' ? 'parentId' : 'projectId']).toBe(key);
    });
    it.each(['create', 'update'] as const)('keeps root-only %s on the database default isolation', async (kind) => {
      planning = true;
      const job = await execute(
        kind,
        {
          ...(kind === 'update' ? { filterByTk: 3 } : {}),
          values: { ...(kind === 'create' ? { id: 100 } : {}), name: 'Scalar' },
        },
        null,
      );
      expect(job.status, job.result?.stack).toBe(EXECUTION_STATUS.RESOLVED);
      expect(planningCalls).toBe(1);
      expect(actualIsolation).toBe('read committed');
      expect((await get(kind === 'create' ? 100 : 3)).name).toBe('Scalar');
    });
    it.each(['create', 'update'] as const)('does not turn %s transaction planning into target access', async (kind) => {
      planning = true;
      const job = await execute(
        kind,
        {
          ...(kind === 'update' ? { filterByTk: 3 } : {}),
          values: { ...(kind === 'create' ? { id: 100 } : {}), project: 102 },
        },
        null,
      );
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(actualIsolation).toBe('serializable');
      expect((request.transaction as Transaction & { finished?: string }).finished).toBe('rollback');
      expect(await get(100)).toBeUndefined();
      expect((await get(3)).projectId).toBe(103);
    });
    it.each(['create', 'update'] as const)(
      'rolls back a planned %s after stored reference verification fails',
      async (kind) => {
        planning = tamper = true;
        const job = await execute(
          kind,
          {
            ...(kind === 'update' ? { filterByTk: 3 } : {}),
            values: { ...(kind === 'create' ? { id: 100 } : {}), project: 101 },
          },
          null,
        );
        expect(job.status).toBe(EXECUTION_STATUS.ERROR);
        expect((request.transaction as Transaction & { finished?: string }).finished).toBe('rollback');
        expect(await get(100)).toBeUndefined();
        expect((await get(3)).projectId).toBe(103);
      },
    );
    it('does not invoke planning to upgrade an insufficient caller transaction', async () => {
      planning = true;
      const job = await execute('update', { filterByTk: 3, values: { project: 101 } }, false);
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(planningCalls).toBe(0);
      expect(actualIsolation).toBe('read committed');
      expect((await get(3)).projectId).toBe(103);
    });
  });

  it.each(['create', 'update'] as const)(
    'writes %s references under the actual configured operation without manual ACL',
    async (kind) => {
      const job = await execute(kind, {
        ...(kind === 'update' ? { filterByTk: 1 } : {}),
        values: { ...(kind === 'create' ? { id: 100 } : {}), name: 'Edited', project: 103, alternative: 104 },
      });
      expect(job.status, job.result?.stack).toBe(EXECUTION_STATUS.RESOLVED);
      expect(await get(kind === 'create' ? 100 : 1)).toMatchObject({
        name: 'Edited',
        projectId: 103,
        alternativeId: 104,
        tenantId: 'B',
      });
      const row = kind === 'create' ? job.result : job.result.data[0];
      expect(row).toMatchObject({ projectId: 103, alternativeId: 104 });
      expect(row.project).toBeUndefined();
      expect((await projects.model.findByPk(104)).getDataValue('tenantId')).toBeNull();
    },
  );
  it.each(['create', 'update'] as const)('allows a visibility-only target on %s', async (kind) => {
    const job = await execute(kind, {
      ...(kind === 'update' ? { filterByTk: 3 } : {}),
      values: { ...(kind === 'create' ? { id: 100 } : {}), project: 101 },
    });
    expect(job.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect((await get(kind === 'create' ? 100 : 3)).projectId).toBe(101);
  });
  it.each(['create', 'update'] as const)('supports an existing same-table reference on %s', async (kind) => {
    const job = await execute(kind, {
      ...(kind === 'update' ? { filterByTk: 3 } : {}),
      values: { ...(kind === 'create' ? { id: 100 } : {}), parent: 1 },
    });
    expect(job.status, job.result?.stack).toBe(EXECUTION_STATUS.RESOLVED);
    expect((await get(kind === 'create' ? 100 : 3)).parentId).toBe(1);
  });
  it.each([102, 999])('rejects hidden or missing new reference %s atomically', async (key) => {
    const job = await execute('update', { filterByTk: 1, values: { name: 'No', project: 103, alternative: key } });
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect(await get()).toMatchObject({ name: 'First', projectId: 101, alternativeId: null });
  });
  it('requires source G even when the target is readable', async () => {
    const job = await execute('update', { filterByTk: [1, 2], values: { project: 103 } });
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect((await get()).projectId).toBe(101);
  });
  it('updates references only for root conditions matching G', async () => {
    const job = await execute('update', { filter: { id: { $in: [1, 2, 3] } }, values: { project: 104 } });
    expect(job.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result.length).toBe(2);
    expect((await get(2)).projectId).toBe(102);
  });
  it('preserves an unchanged hidden reference and permits its ordinary source edit', async () => {
    await documents.model.update({ projectId: 102 }, { where: { id: 1 } });
    const job = await execute('update', { filterByTk: 1, values: { name: 'Edited', project: 102 } });
    expect(job.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(await get()).toMatchObject({ name: 'Edited', projectId: 102 });
  });
  it('does not write when an unchanged reference is the entire patch', async () => {
    const job = await execute('update', { filterByTk: 1, values: { project: 101 } });
    expect(job).toEqual({ status: EXECUTION_STATUS.RESOLVED, result: { length: 0, data: [] } });
  });
  it('clears a hidden reference without requiring new target access', async () => {
    await documents.model.update({ projectId: 102 }, { where: { id: 1 } });
    const job = await execute('update', { filterByTk: 1, values: { project: null } });
    expect(job.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect((await get()).projectId).toBeNull();
  });
  it('claims an editable legacy source while merely referencing a legacy target', async () => {
    await save(
      source,
      configFor({
        type: 'any',
        children: [ownerCondition, { type: 'isNull', operand: { type: 'field', path: 'tenantId' } }],
      }),
    );
    const job = await execute('update', { filterByTk: 5, values: { project: 104 } });
    expect(job.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(await get(5)).toMatchObject({ tenantId: 'B', projectId: 104 });
    expect((await projects.model.findByPk(104)).getDataValue('tenantId')).toBeNull();
  });
  it('does not claim an unchanged legacy row in a mixed reference batch', async () => {
    await save(
      source,
      configFor({
        type: 'any',
        children: [ownerCondition, { type: 'isNull', operand: { type: 'field', path: 'tenantId' } }],
      }),
    );
    await documents.model.update({ projectId: 103 }, { where: { id: 5 } });
    const job = await execute('update', { filterByTk: [1, 5], values: { project: 103 } });
    expect(job.status, job.result?.stack).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result.length).toBe(1);
    expect(job.result.data.map((row) => row.id)).toEqual([1]);
    expect(await get(1)).toMatchObject({ tenantId: 'B', projectId: 103 });
    expect(await get(5)).toMatchObject({ tenantId: null, projectId: 103 });
  });
  it('claims a legacy row when scalar fields change despite an unchanged reference', async () => {
    await save(
      source,
      configFor({
        type: 'any',
        children: [ownerCondition, { type: 'isNull', operand: { type: 'field', path: 'tenantId' } }],
      }),
    );
    await documents.model.update({ projectId: 103 }, { where: { id: 5 } });
    const job = await execute('update', { filterByTk: [1, 5], values: { name: 'Edited', project: 103 } });
    expect(job.status, job.result?.stack).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result.length).toBe(2);
    expect(await get(5)).toMatchObject({ name: 'Edited', tenantId: 'B', projectId: 103 });
  });
  it('checks G for an unchanged row before omitting it from a mixed reference batch', async () => {
    const job = await execute('update', { filterByTk: [2, 3], values: { project: 102 } });
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect(await get(2)).toMatchObject({ tenantId: 'C', projectId: 102 });
    expect(await get(3)).toMatchObject({ tenantId: 'B', projectId: 103 });
  });
  it.each(['create', 'update'] as const)('rejects insufficient inherited isolation for %s references', async (kind) => {
    const job = await execute(
      kind,
      { ...(kind === 'update' ? { filterByTk: 1 } : {}), values: { project: 103 } },
      false,
    );
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.result.message).toMatch(/isolation|serializable/i);
  });
  it('rolls back earlier source writes if a later row fails', async () => {
    failLater = true;
    const job = await execute('update', { values: { name: 'No partial commit', project: 104 } });
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.result.message).toBe('later reference update failed');
    expect((await get()).projectId).toBe(101);
  });
  it.each(['create', 'update'] as const)('rejects a hook changing the authorized %s reference', async (kind) => {
    tamper = true;
    const job = await execute(kind, {
      ...(kind === 'update' ? { filterByTk: 1 } : {}),
      values: { ...(kind === 'create' ? { id: 100 } : {}), project: 103 },
    });
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect(await get(100)).toBeUndefined();
    expect((await get()).projectId).toBe(101);
  });
  it.each(['create', 'update'] as const)('rejects a released preparation phase during %s', async (kind) => {
    release = true;
    const job = await execute(kind, {
      ...(kind === 'update' ? { filterByTk: 1 } : {}),
      values: { ...(kind === 'create' ? { id: 100 } : {}), project: 103 },
    });
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect((await get()).projectId).toBe(101);
  });
  it.each([{ project: { id: 103, name: 'No nested edit' } }, { projectId: 103 }, { project: 103, projectId: 102 }])(
    'rejects unsupported target writes %j',
    async (values) => {
      const job = await execute('update', { filterByTk: 1, values });
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect((await get()).projectId).toBe(101);
      expect((await projects.model.findByPk(103)).getDataValue('name')).toBe('Owned');
    },
  );
  it('captures reference keys and canonical actor before configuration loading', async () => {
    const read = store.read.bind(store);
    vi.spyOn(store, 'read').mockImplementation(async (identity) => {
      const config = await read(identity);
      request.params.values.project = 102;
      request.context.state.currentTenantId = 'C';
      return config;
    });
    const job = await execute('create', { values: { id: 100, project: 103 } });
    expect(job.status, job.result?.stack).toBe(EXECUTION_STATUS.RESOLVED);
    expect(await get(100)).toMatchObject({ projectId: 103, tenantId: 'B' });
  });
  it.each(['identity', 'association', 'interface', 'column'] as const)(
    'rejects %s changes during preparation',
    async (part) => {
      const read = store.read.bind(store);
      const key = target.collectionKey;
      const relation = documents.model.associations.alternative;
      const field = documents.getField('alternative');
      const kind = field.options.interface;
      const column = projects.model.rawAttributes.name.field;
      vi.spyOn(store, 'read').mockImplementation(async (identity) => {
        const config = await read(identity);
        if (part === 'identity') target.collectionKey = 'replacement';
        else if (part === 'association') documents.model.associations.alternative = Object.create(relation);
        else if (part === 'interface') field.options.interface = 'attachment';
        else projects.model.rawAttributes.name.field = 'replacement_name';
        return config;
      });
      let job;
      try {
        job = await execute('create', { values: { id: 100, project: 103, alternative: 104 } });
      } finally {
        target.collectionKey = key;
        documents.model.associations.alternative = relation;
        field.options.interface = kind;
        projects.model.rawAttributes.name.field = column;
      }
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(await get(100)).toBeUndefined();
    },
  );
  it.each([103, 101])('checks create G against the actual persisted reference: %s', async (key) => {
    await save(
      source,
      configFor({
        type: 'exists',
        path: 'project',
        condition: {
          type: 'compare',
          operator: 'eq',
          left: { type: 'field', path: 'name' },
          right: { type: 'literal', value: 'Owned' },
        },
      }),
    );
    const job = await execute('create', { values: { id: 100, project: key } });
    expect(job.status).toBe(key === 103 ? EXECUTION_STATUS.RESOLVED : EXECUTION_STATUS.ERROR);
    expect(!!(await get(100))).toBe(key === 103);
  });
  it('returns zero for a valid empty source selection without selecting its hidden target', async () => {
    const job = await execute('update', { filter: { id: 999 }, values: { project: 102 } });
    expect(job).toEqual({ status: EXECUTION_STATUS.RESOLVED, result: { length: 0, data: [] } });
  });
  it('does not treat a zero target key as clearing the reference', async () => {
    await projects.model.create({ id: 0, name: 'Owned zero', tenantId: 'B' });
    const job = await execute('update', { filterByTk: 1, values: { project: 0 } });
    expect(job.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect((await get()).projectId).toBe(0);
  });
  it('requires an explicit target configuration even when clearing a reference', async () => {
    const read = store.read.bind(store);
    vi.spyOn(store, 'read').mockImplementation((identity) =>
      identity.collectionName === projects.name ? Promise.resolve(null) : read(identity),
    );
    const job = await execute('update', { filterByTk: 1, values: { project: null } });
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect((await get()).projectId).toBe(101);
  });
});

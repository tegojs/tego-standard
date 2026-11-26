import { createMockServer, type MockServer } from '@tachybase/test';

import { EXECUTION_STATUS, JOB_STATUS } from '../../../../../module-workflow/src/server/constants';
import type WorkflowPlugin from '../../../../../module-workflow/src/server/Plugin';
import { accessConfigHistory } from '../../access-control/config-history';
import type { AccessCollectionIdentity } from '../../access-control/config-store';
import { AccessMainWorkflowQueryRuntime } from '../../access-control/main-workflow-query-runtime';
import type { AccessWorkflowQueryRequest } from '../../access-control/workflow-query-handler';
import { configFor, ownerCondition } from './fixtures';

describe('explicit main-source workflow query runtime', () => {
  let app: MockServer;
  let plugin: WorkflowPlugin;
  let runtime: AccessMainWorkflowQueryRuntime;
  let source: AccessCollectionIdentity;
  let selected: AccessCollectionIdentity[];
  let workflow;
  let activeQueryRequest: AccessWorkflowQueryRequest | undefined;

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
            queryResolver: (request) => {
              activeQueryRequest = request;
              return runtime.resolve(request, selected);
            },
            selectResolver: (request) => {
              activeQueryRequest = request;
              return runtime.resolve(request, selected);
            },
          },
        ],
      ],
    });
    plugin = app.pm.get('workflow') as WorkflowPlugin;
    const stored = await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: 'runtimeDocuments',
        tenancy: 'tenantScoped',
        fields: [
          { name: 'name', type: 'string' },
          { name: 'tenantId', type: 'string' },
        ],
      },
    });
    source = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName: 'runtimeDocuments' };
    await app.db.getCollection(source.collectionName).model.sync();
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
    runtime = new AccessMainWorkflowQueryRuntime(app, (request) => plugin.captureDataOperationAuthority(request));
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
    await runtime.registry.store.save(source, { ...config, revision: 0 }, { userId: 28 });
    await app.db.getCollection(source.collectionName).model.bulkCreate([
      { id: 1, name: 'Visible', tenantId: 'H' },
      { id: 2, name: 'Owned B', tenantId: 'B' },
      { id: 3, name: 'Owned C', tenantId: 'C' },
    ]);
    await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: 'legacyRuntimeSources',
        tenancy: 'tenantScoped',
        fields: [
          { name: 'name', type: 'string' },
          { name: 'tenantId', type: 'string' },
          { name: 'document', type: 'belongsTo', target: source.collectionName, foreignKey: 'documentId' },
        ],
      },
    });
    await app.db
      .getCollection('legacyRuntimeSources')
      .model.bulkCreate([{ id: 1, name: 'Legacy B', tenantId: 'B', documentId: 2 }]);
  });

  beforeEach(async () => {
    activeQueryRequest = undefined;
    selected = [{ ...source }];
    workflow = await app.db.getRepository('workflows').create({
      values: {
        title: 'Explicit access query selection',
        type: 'collection',
        sync: true,
        enabled: true,
        config: { collection: 'runtimeEvents', mode: 1 },
      },
    });
    await workflow.createNode({
      type: 'query',
      config: {
        collection: source.collectionName,
        multiple: true,
        params: { fields: ['name'], sort: [{ field: 'id' }], paginate: false },
      },
    });
  });
  afterEach(async () => {
    await workflow?.update({ enabled: false });
  });
  afterAll(async () => {
    await app?.destroy();
  });

  async function execute(tenant: string | null = 'B') {
    await plugin.trigger(workflow, {}, { context: { state: { currentTenantId: tenant } } });
    const [execution] = await workflow.getExecutions({ order: [['id', 'DESC']] });
    const [job] = await execution.getJobs();
    return { execution, job };
  }

  async function useInstruction(type: 'query' | 'select') {
    const [node] = await workflow.getNodes();
    await node.update({ type });
    return node;
  }

  it.each(['query', 'select'] as const)(
    'discovers persistent identity and G or V in real B and C %s executions',
    async (type) => {
      await useInstruction(type);
      const b = await execute();
      expect(b.execution.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(b.job.status).toBe(JOB_STATUS.RESOLVED);
      expect(b.job.result).toEqual([{ name: 'Owned B' }]);
      const c = await execute('C');
      expect(c.execution.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(c.job.result).toEqual([{ name: 'Owned C' }]);
    },
  );

  it.each(['query', 'select'] as const)(
    'keeps an unselected configured table on the existing workflow %s path',
    async (type) => {
      await useInstruction(type);
      selected = [];
      const { execution, job } = await execute();
      expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(job.result).toEqual([{ name: 'Owned B' }]);
    },
  );

  it('applies the same current deny rules to a real select node instead of the old tenant-only list', async () => {
    const original = (await runtime.registry.store.read(source))!;
    try {
      await runtime.registry.store.save(source, { ...original, rules: [] }, { userId: 28 });
      const direct = await execute();
      expect(direct.execution.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(direct.job.result).toEqual([]);
      const [node] = await workflow.getNodes();
      await node.update({ type: 'select' });
      const selected = await execute();
      expect(selected.execution.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(selected.job.result).toEqual([]);
    } finally {
      const current = (await runtime.registry.store.read(source))!;
      await runtime.registry.store.save(source, { ...original, revision: current.revision }, { userId: 28 });
    }
  });

  it('extracts a select summary only from the current G or V rows', async () => {
    const direct = await execute();
    expect(direct.job.result).toEqual([{ name: 'Owned B' }]);
    const [node] = await workflow.getNodes();
    await node.update({
      type: 'select',
      config: { ...node.config, params: { ...node.config.params, summary: 'name' } },
    });
    const selected = await execute();
    expect(selected.execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(selected.job.result).toEqual(['Owned B']);
  });

  it.each([
    { summary: undefined, expected: { name: 'Owned B' } },
    { summary: 'name', expected: 'Owned B' },
  ])('reads one authorized select result with summary=$summary', async ({ summary, expected }) => {
    const node = await useInstruction('select');
    await node.update({
      config: {
        ...node.config,
        multiple: false,
        params: { ...node.config.params, ...(summary ? { summary } : {}) },
      },
    });
    const { execution, job } = await execute();
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    expect(job.result).toEqual(expected);
  });

  it.each([
    { multiple: true, failOnEmpty: false },
    { multiple: true, failOnEmpty: true },
    { multiple: false, failOnEmpty: false },
    { multiple: false, failOnEmpty: true },
  ])('preserves empty select status for $multiple/$failOnEmpty', async ({ multiple, failOnEmpty }) => {
    const original = (await runtime.registry.store.read(source))!;
    try {
      await runtime.registry.store.save(source, { ...original, rules: [] }, { userId: 28 });
      const node = await useInstruction('select');
      await node.update({ config: { ...node.config, multiple, failOnEmpty } });
      const { execution, job } = await execute();
      expect(execution.status).toBe(failOnEmpty ? EXECUTION_STATUS.FAILED : EXECUTION_STATUS.RESOLVED);
      expect(job.status).toBe(failOnEmpty ? JOB_STATUS.FAILED : JOB_STATUS.RESOLVED);
      expect(job.result).toEqual(multiple ? [] : null);
    } finally {
      const current = (await runtime.registry.store.read(source))!;
      await runtime.registry.store.save(source, { ...original, revision: current.revision }, { userId: 28 });
    }
  });

  it('rejects a legacy select summary across a selected target after proving the unselected path', async () => {
    const original = (await runtime.registry.store.read(source))!;
    try {
      await runtime.registry.store.save(source, { ...original, rules: [] }, { userId: 28 });
      const direct = await execute();
      expect(direct.execution.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(direct.job.result).toEqual([]);
      const [node] = await workflow.getNodes();
      await node.update({
        type: 'select',
        config: {
          collection: 'legacyRuntimeSources',
          multiple: true,
          params: { summary: 'document.name', paginate: false },
        },
      });
      selected = [];
      const legacy = await execute();
      expect(legacy.execution.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(legacy.job.result).toEqual(['Owned B']);
      selected = [{ ...source }];
      const rejected = await execute();
      expect({
        status: rejected.execution.status,
        result: Array.isArray(rejected.job.result) ? rejected.job.result : null,
      }).toEqual({ status: EXECUTION_STATUS.ERROR, result: null });
      expect(rejected.job.status).toBe(JOB_STATUS.ERROR);
    } finally {
      selected = [{ ...source }];
      const current = (await runtime.registry.store.read(source))!;
      await runtime.registry.store.save(source, { ...original, revision: current.revision }, { userId: 28 });
    }
  });

  it.each(['query', 'select'] as const)(
    'rejects a mismatched %s persistent key without retrying the old repository',
    async (type) => {
      await useInstruction(type);
      selected = [{ ...source, collectionKey: 'different-persistent-key' }];
      const { execution, job } = await execute();
      expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
      expect(job.status).toBe(JOB_STATUS.ERROR);
      expect(Array.isArray(job.result)).toBe(false);
    },
  );

  it.each(['query', 'select'] as const)(
    'reads the next %s execution configuration without retaining old G or V',
    async (type) => {
      await useInstruction(type);
      const original = (await runtime.registry.store.read(source))!;
      const first = await execute();
      expect(first.job.result).toEqual([{ name: 'Owned B' }]);
      try {
        await runtime.registry.store.save(
          source,
          {
            ...original,
            rules: original.rules.filter((rule) => rule.id !== 'visible'),
          },
          { userId: 28 },
        );
        const next = await execute();
        expect(next.execution.status).toBe(EXECUTION_STATUS.RESOLVED);
        expect(next.job.result).toEqual([{ name: 'Owned B' }]);
      } finally {
        const current = (await runtime.registry.store.read(source))!;
        await runtime.registry.store.save(source, { ...original, revision: current.revision }, { userId: 28 });
      }
    },
  );

  it.each(['query', 'select'] as const)(
    'does not run selected %s data without a trusted execution tenant',
    async (type) => {
      await useInstruction(type);
      const { execution, job } = await execute(null);
      expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
      expect(job.status).toBe(JOB_STATUS.ERROR);
      expect(Array.isArray(job.result)).toBe(false);
    },
  );

  it.each((['query', 'select'] as const).flatMap((type) => ['filter', 'fields'].map((kind) => ({ type, kind }))))(
    'rejects $type $kind changed during persistent discovery',
    async ({ type, kind }) => {
      const node = await useInstruction(type);
      await node.update({
        config: {
          ...node.config,
          params: { fields: ['name'], filter: { id: { $eq: 2 } }, paginate: false },
        },
      });
      const baseline = await execute();
      expect(baseline.execution.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(baseline.job.result).toEqual([{ name: 'Owned B' }]);
      activeQueryRequest = undefined;
      const metadata = app.db.getCollection('collections').model;
      const original = metadata.findAll;
      let changed = false;
      const delivery = vi.spyOn(metadata, 'findAll').mockImplementation(async function (options) {
        const result = await original.call(this, options);
        if (activeQueryRequest && !changed) {
          changed = true;
          if (kind === 'filter') {
            (activeQueryRequest.query.filter as { id: { $eq: number } }).id.$eq = 1;
          } else {
            (activeQueryRequest.query.fields as string[])[0] = 'tenantId';
          }
        }
        return result;
      });
      try {
        const { execution, job } = await execute();
        expect(changed).toBe(true);
        expect({ status: execution.status, result: Array.isArray(job.result) ? job.result : null }).toEqual({
          status: EXECUTION_STATUS.ERROR,
          result: null,
        });
        expect(job.status).toBe(JOB_STATUS.ERROR);
      } finally {
        delivery.mockRestore();
      }
    },
  );

  it.each(['appends', 'filter'] as const)('rejects legacy-to-protected workflow %s paths', async (kind) => {
    const original = (await runtime.registry.store.read(source))!;
    try {
      await runtime.registry.store.save(source, { ...original, rules: [] }, { userId: 28 });
      const [node] = await workflow.getNodes();
      await node.update({
        config: {
          collection: 'legacyRuntimeSources',
          multiple: true,
          params: {
            fields: ['name'],
            paginate: false,
            ...(kind === 'appends' ? { appends: ['document'] } : { filter: { 'document.name': 'Owned B' } }),
          },
        },
      });
      const { execution, job } = await execute();
      expect(job.result).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Legacy B' })]));
      expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
      expect(job.status).toBe(JOB_STATUS.ERROR);
      expect(Array.isArray(job.result)).toBe(false);
    } finally {
      const current = (await runtime.registry.store.read(source))!;
      await runtime.registry.store.save(source, { ...original, revision: current.revision }, { userId: 28 });
    }
  });

  it('keeps legacy scalar reads and unselected association targets on the existing query path', async () => {
    const [node] = await workflow.getNodes();
    const config = {
      collection: 'legacyRuntimeSources',
      multiple: true,
      params: { fields: ['name'], paginate: false },
    };
    await node.update({ config });
    const scalar = await execute();
    expect(scalar.execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(scalar.job.result).toEqual([{ name: 'Legacy B' }]);
    selected = [];
    await node.update({ config: { ...config, params: { ...config.params, appends: ['document'] } } });
    const unselected = await execute();
    expect(unselected.execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(unselected.job.result[0].document.id).toBe(2);
  });
});

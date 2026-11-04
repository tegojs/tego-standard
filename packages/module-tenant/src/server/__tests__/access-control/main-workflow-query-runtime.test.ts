import { createMockServer, type MockServer } from '@tachybase/test';

import { EXECUTION_STATUS, JOB_STATUS } from '../../../../../module-workflow/src/server/constants';
import type WorkflowPlugin from '../../../../../module-workflow/src/server/Plugin';
import { accessConfigHistory } from '../../access-control/config-history';
import type { AccessCollectionIdentity } from '../../access-control/config-store';
import { AccessMainWorkflowQueryRuntime } from '../../access-control/main-workflow-query-runtime';
import { configFor, ownerCondition } from './fixtures';

describe('explicit main-source workflow query runtime', () => {
  let app: MockServer;
  let plugin: WorkflowPlugin;
  let runtime: AccessMainWorkflowQueryRuntime;
  let source: AccessCollectionIdentity;
  let selected: AccessCollectionIdentity[];
  let workflow;

  beforeAll(async () => {
    app = await createMockServer({
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: [
        'error-handler',
        'collection',
        'user',
        ['workflow', { queryResolver: (request) => runtime.resolve(request, selected) }],
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

  it('discovers persisted table identity and applies G or V in real B and C executions', async () => {
    const b = await execute();
    expect(b.execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(b.job.status).toBe(JOB_STATUS.RESOLVED);
    expect(b.job.result).toEqual([{ name: 'Visible' }, { name: 'Owned B' }]);
    const c = await execute('C');
    expect(c.execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(c.job.result).toEqual([{ name: 'Visible' }, { name: 'Owned C' }]);
  });

  it('keeps an unselected configured table on the existing workflow query path', async () => {
    selected = [];
    const { execution, job } = await execute();
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result).toEqual([{ name: 'Owned B' }]);
  });

  it('rejects a mismatched server persistent key without retrying the old repository', async () => {
    selected = [{ ...source, collectionKey: 'different-persistent-key' }];
    const { execution, job } = await execute();
    expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.status).toBe(JOB_STATUS.ERROR);
    expect(Array.isArray(job.result)).toBe(false);
  });

  it('reads the next execution configuration rather than retaining the previous G or V result', async () => {
    const original = (await runtime.registry.store.read(source))!;
    const first = await execute();
    expect(first.job.result).toEqual([{ name: 'Visible' }, { name: 'Owned B' }]);
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
  });

  it('does not query selected tenant data without a trusted execution tenant', async () => {
    const { execution, job } = await execute(null);
    expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.status).toBe(JOB_STATUS.ERROR);
    expect(Array.isArray(job.result)).toBe(false);
  });

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

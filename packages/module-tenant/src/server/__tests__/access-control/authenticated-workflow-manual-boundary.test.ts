import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';
import type { Model } from '@tego/server';

import WorkflowPlugin, { EXECUTION_STATUS, JOB_STATUS } from '../../../../../module-workflow/src/server';
import ManualInstruction, {
  type WorkflowManualFormGuard,
} from '../../../../../module-workflow/src/server/features/manual/ManualInstruction';
import { accessConfigHistory } from '../../access-control/config-history';
import type { AccessCollectionIdentity } from '../../access-control/config-store';
import { AccessMainWorkflowWriteRuntime } from '../../access-control/main-workflow-write-runtime';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreFactoryEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreFactoryEntry)('authenticated manual workflow write boundaries', () => {
  let app: MockServer;
  let plugin: WorkflowPlugin;
  let runtime: AccessMainWorkflowWriteRuntime;
  let source: AccessCollectionIdentity;
  let selected: AccessCollectionIdentity[];
  let user: Model;
  let token: string;
  let outsiderToken: string;
  let workflow;
  let guardMode: 'boundary' | 'async' | 'invalid';
  const role = 'manual-write-participant';
  const password = 'manual-workflow-boundary-password';
  const agent = (bearer = token) =>
    app
      .agent()
      .set('Authorization', `Bearer ${bearer}`)
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
            createResolver: (request) => runtime.resolveCreate(request, selected),
            updateResolver: (request) => runtime.resolveUpdate(request, selected),
            createTransactionPlanner: (target) => runtime.plan(target, selected),
            updateTransactionPlanner: (target) => runtime.plan(target, selected),
            manualFormGuard: (request) => {
              expect(Object.isFrozen(request)).toBe(true);
              expect(() => plugin.captureDataOperationAuthority(request)).toThrow(/authority/i);
              if (guardMode === 'async') return Promise.resolve();
              if (guardMode === 'invalid') return true;
              return runtime.assertManualFormBoundary(request, selected);
            },
          },
        ],
      ],
    });
    plugin = app.pm.get('workflow') as WorkflowPlugin;
    plugin.options.manualFormGuard = () => {
      throw new Error('Startup manual guard was replaced');
    };
    runtime = new AccessMainWorkflowWriteRuntime(app, (request) => plugin.captureDataOperationAuthority(request));
    for (const id of ['H', 'B', 'C']) {
      await app.db.getRepository('tenants').create({ values: { id, name: id, enabled: true } });
    }
    await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
    user = await app.db.getRepository('users').create({
      values: { username: role, password, roles: [role], tenants: ['B'], defaultTenantId: 'B' },
    });
    const signedIn = await app
      .agent()
      .post('/auth:signIn')
      .set('X-Authenticator', 'basic')
      .send({ account: role, password });
    expect(signedIn.status).toBe(200);
    expect(String(signedIn.body.data.user.id)).toBe(String(user.get('id')));
    expect(signedIn.body.data.user.hasPassword).toBe(true);
    token = signedIn.body.data.token;
    expect(token).toEqual(expect.any(String));
    await app.db.getRepository('users').create({
      values: { username: 'manual-outsider', password, roles: [role], tenants: ['B'], defaultTenantId: 'B' },
    });
    const outsider = await app
      .agent()
      .post('/auth:signIn')
      .set('X-Authenticator', 'basic')
      .send({ account: 'manual-outsider', password });
    expect(outsider.status).toBe(200);
    outsiderToken = outsider.body.data.token;
    const stored = await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: 'manualBoundaryDocuments',
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
    await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: 'manualBoundaryLegacy',
        tenancy: 'tenantScoped',
        timestamps: false,
        createdBy: false,
        updatedBy: false,
        fields: [
          { name: 'name', type: 'string' },
          { name: 'document', type: 'belongsTo', target: source.collectionName, foreignKey: 'documentId' },
        ],
      },
    });
    await app.db.getRepository('collections').create({
      context: {},
      values: { name: 'manualBoundaryEvents', tenancy: 'shared', fields: [{ name: 'name', type: 'string' }] },
    });
    await app.db.collection(accessConfigHistory).model.sync();
    await runtime.registry.store.save(
      source,
      {
        ...configFor({
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
        }),
        revision: 0,
      },
      { userId: user.get('id') },
    );
  });

  beforeEach(async () => {
    guardMode = 'boundary';
    selected = [{ ...source }];
    const legacy = app.db.getCollection('manualBoundaryLegacy').model;
    await legacy.destroy({ where: {}, hooks: false });
    const model = app.db.getCollection(source.collectionName).model;
    await model.destroy({ where: {}, hooks: false });
    await model.bulkCreate([
      { id: 1, name: 'Owned H', amount: 100, tenantId: 'H' },
      { id: 2, name: 'Owned B', amount: 200, tenantId: 'B' },
      { id: 3, name: 'Owned C', amount: 300, tenantId: 'C' },
      { id: 4, name: 'Excluded B', amount: 5, tenantId: 'B' },
    ]);
    await legacy.bulkCreate([{ id: 1, name: 'Legacy source', documentId: 2, tenantId: 'B' }]);
    workflow = await app.db.getRepository('workflows').create({
      values: {
        title: 'Manual write boundary',
        type: 'collection',
        enabled: true,
        sync: true,
        config: { collection: 'manualBoundaryEvents', mode: 1 },
      },
    });
  });

  afterEach(async () => {
    await idle();
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

  async function trigger(expectedStatus: number) {
    const response = await agent()
      .resource('workflows')
      .trigger({ filterByTk: workflow.id, updateData: encodeURIComponent('{}') });
    expect([200, 204]).toContain(response.status);
    await vi.waitFor(
      async () => {
        const [execution] = await workflow.getExecutions({ order: [['id', 'DESC']] });
        expect(execution?.status).toBe(expectedStatus);
      },
      { timeout: 10000, interval: 50 },
    );
    await idle();
    const [execution] = await workflow.getExecutions({ order: [['id', 'DESC']] });
    return execution;
  }

  async function idle() {
    const queue = plugin as unknown as { executing: Promise<void> | null; events: unknown[]; pending: unknown[] };
    await vi.waitFor(
      () => {
        expect(queue.executing).toBeFalsy();
        expect(queue.events).toHaveLength(0);
        expect(queue.pending).toHaveLength(0);
      },
      { timeout: 10000, interval: 50 },
    );
  }

  it.each(['create', 'update'] as const)('rejects the selected manual %s path before business writes', async (type) => {
    const values = { name: 'Manual write', ...(type === 'create' ? { amount: 5 } : {}) };
    const before = await rows();
    const node = await workflow.createNode({
      type,
      config: {
        collection: source.collectionName,
        params: { values, ...(type === 'update' ? { filterByTk: 4 } : {}) },
      },
    });
    const ordinary = await trigger(EXECUTION_STATUS.ERROR);
    expect(ordinary.status).toBe(EXECUTION_STATUS.ERROR);
    expect(await rows()).toEqual(before);
    await node.update({
      type: 'manual',
      config: {
        assignees: [user.get('id')],
        forms: {
          form: {
            type,
            dataSource: 'main',
            collection: source.collectionName,
            filter: { id: 4 },
            actions: [{ key: 'confirm', status: JOB_STATUS.RESOLVED }],
          },
        },
      },
    });
    const execution = await trigger(EXECUTION_STATUS.STARTED);
    expect(execution.status).toBe(EXECUTION_STATUS.STARTED);
    expect(execution.tenantId).toBe('B');
    const pending = await app.db.getRepository('users_jobs').findOne({ filter: { executionId: execution.id } });
    expect(pending.get('status')).toBe(JOB_STATUS.PENDING);
    expect(pending.get('userId')).toBe(user.get('id'));
    const pendingBefore = pending.toJSON();
    const executionBefore = execution.toJSON();
    const jobsBefore = (await execution.getJobs()).map((job) => job.toJSON());
    const submit = (bearer = token) =>
      agent(bearer)
        .resource('users_jobs')
        .submit({
          filterByTk: pending.get('id'),
          values: { result: { form: values, _: 'confirm' } },
        });
    expect((await submit(outsiderToken)).status).toBe(403);
    const response = await submit();
    expect({ status: response.status, rows: await rows() }).toEqual({ status: 400, rows: before });
    expect(response.body.errors[0].message).toMatch(/manual forms require a dedicated adapter/i);
    await pending.reload();
    await execution.reload();
    expect(pending.toJSON()).toEqual(pendingBefore);
    expect(execution.toJSON()).toEqual(executionBefore);
    expect((await execution.getJobs()).map((job) => job.toJSON())).toEqual(jobsBefore);

    selected = [];
    expect((await submit()).status).toBe(202);
    await vi.waitFor(async () => {
      await execution.reload();
      expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    });
    await idle();
    await pending.reload();
    expect(pending.get('status')).toBe(JOB_STATUS.RESOLVED);
    const after = await rows();
    if (type === 'create') {
      expect(after.slice(0, 4)).toEqual(before);
      expect(after[4]).toMatchObject({ name: 'Manual write', amount: 5, tenantId: 'B' });
      expect(after).toHaveLength(5);
    } else {
      expect(after.slice(0, 3)).toEqual(before.slice(0, 3));
      expect(after[3]).toEqual({ ...before[3], name: 'Manual write' });
      expect(after).toHaveLength(4);
    }
  });

  it.each(['create', 'update'] as const)(
    'refuses async and invalid guard results before manual %s writes',
    async (type) => {
      selected = [];
      await workflow.createNode({
        type: 'manual',
        config: {
          assignees: [user.get('id')],
          forms: {
            form: {
              type,
              collection: source.collectionName,
              filter: { id: 2 },
              actions: [{ key: 'confirm', status: JOB_STATUS.RESOLVED }],
            },
          },
        },
      });
      const execution = await trigger(EXECUTION_STATUS.STARTED);
      const pending = await app.db.getRepository('users_jobs').findOne({ filter: { executionId: execution.id } });
      const before = await rows();
      const pendingBefore = pending.toJSON();
      for (const mode of ['async', 'invalid'] as const) {
        guardMode = mode;
        const response = await agent()
          .resource('users_jobs')
          .submit({
            filterByTk: pending.get('id'),
            values: { result: { form: { name: 'Must not persist', amount: 200 }, _: 'confirm' } },
          });
        expect(response.status).toBe(500);
        expect(response.body.errors[0].message).toMatch(/return undefined synchronously/i);
        expect(await rows()).toEqual(before);
        await pending.reload();
        expect(pending.toJSON()).toEqual(pendingBefore);
      }
    },
  );

  it('rejects a non-function bootstrap guard', () => {
    const original = plugin.options.manualFormGuard;
    try {
      plugin.options.manualFormGuard = true as unknown as WorkflowManualFormGuard;
      expect(() => new ManualInstruction(plugin)).toThrow(/guard must be a function/i);
    } finally {
      plugin.options.manualFormGuard = original;
    }
  });

  it.each([
    { type: 'create', values: { name: 'Reference', documentId: 2 }, filter: {} },
    { type: 'update', values: { name: 'Reference', documentId: 2 }, filter: { id: 1 } },
    { type: 'update', values: { name: 'Read match' }, filter: { 'document.id': 2 } },
  ])('rejects legacy manual $type crossing a selected target ($values.name)', async ({ type, values, filter }) => {
    await workflow.createNode({
      type: 'manual',
      config: {
        assignees: [user.get('id')],
        forms: {
          form: {
            type,
            collection: 'manualBoundaryLegacy',
            filter,
            actions: [{ key: 'confirm', status: JOB_STATUS.RESOLVED }],
          },
        },
      },
    });
    const execution = await trigger(EXECUTION_STATUS.STARTED);
    const pending = await app.db.getRepository('users_jobs').findOne({ filter: { executionId: execution.id } });
    const legacy = app.db.getCollection('manualBoundaryLegacy').model;
    const legacyRows = async () => (await legacy.findAll({ order: [['id', 'ASC']] })).map((row) => row.get());
    const before = await rows();
    const legacyBefore = await legacyRows();
    const pendingBefore = pending.toJSON();
    const submit = () =>
      agent()
        .resource('users_jobs')
        .submit({
          filterByTk: pending.get('id'),
          values: { result: { form: values, _: 'confirm' } },
        });
    const response = await submit();
    expect(response.status).toBe(400);
    expect(response.body.errors[0].message).toMatch(/selected access collections require a dedicated adapter/i);
    expect(await rows()).toEqual(before);
    expect(await legacyRows()).toEqual(legacyBefore);
    await pending.reload();
    expect(pending.toJSON()).toEqual(pendingBefore);

    selected = [];
    expect((await submit()).status).toBe(202);
    await vi.waitFor(async () => {
      await execution.reload();
      expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    });
    await idle();
    expect(await rows()).toEqual(before);
    const after = await legacyRows();
    expect(after).toHaveLength(type === 'create' ? 2 : 1);
    expect(after.at(-1)).toMatchObject({ name: values.name, documentId: 2, tenantId: 'B' });
  });
});

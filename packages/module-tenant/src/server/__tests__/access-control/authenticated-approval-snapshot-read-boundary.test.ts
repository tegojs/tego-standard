import { pathToFileURL } from 'node:url';
import { JOB_STATUS } from '@tachybase/module-workflow';
import type { MockServer } from '@tachybase/test';

import { waitForFastAssertion, waitForWorkflowIdle } from '../../../../../module-workflow/src/server/__tests__/utils';
import {
  APPROVAL_ACTION_STATUS,
  APPROVAL_STATUS,
} from '../../../../../plugin-workflow-approval/src/server/constants/status';
import type PluginWorkflowApproval from '../../../../../plugin-workflow-approval/src/server/plugin';
import { captureApprovalSnapshotReadGuard } from '../../../../../plugin-workflow-approval/src/server/snapshot-read-guard';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import type { AccessCollectionIdentity } from '../../access-control/config-store';
import { AccessMainApprovalReadBoundary } from '../../access-control/main-approval-read-boundary';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreFactoryEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreFactoryEntry)('authenticated approval snapshot read boundaries', () => {
  let app: MockServer;
  let identity: AccessCollectionIdentity;
  let sourceIdentity: AccessCollectionIdentity;
  let token: string;
  let userId: number;
  let workflow;
  let boundary: AccessMainApprovalReadBoundary;
  let guardMode: 'boundary' | 'async' | 'invalid' | 'throw';
  let readCalls = 0;
  let unregister: (() => void) | undefined;
  const selectedKeys = new Set<string>();
  const account = 'approval-snapshot-participant';
  const password = 'approval-snapshot-password';
  const agent = (bearer = token) =>
    app
      .agent()
      .set('Authorization', `Bearer ${bearer}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', account)
      .set('X-Tenant-Id', 'B');

  beforeAll(async () => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreFactoryEntry!).href);
    app = await createTenantApp({
      aclFactory: createACL,
      database: { dialect: 'sqlite', storage: ':memory:' },
      extraPlugins: [
        'workflow',
        [
          'workflow-approval',
          {
            snapshotReadGuard: (request) => {
              readCalls++;
              expect(Object.isFrozen(request)).toBe(true);
              expect(request.context.state.currentTenantId).toBe('B');
              expect(() => app.pm.get('workflow').captureDataOperationAuthority(request)).toThrow(/authority/i);
              if (guardMode === 'async') return Promise.resolve();
              if (guardMode === 'invalid') return true;
              if (guardMode === 'throw') throw new Error('Snapshot read rejected');
              return boundary.assert(
                request,
                [identity, sourceIdentity].filter((item) => selectedKeys.has(item.collectionKey)),
              );
            },
          },
        ],
      ],
    });
    boundary = new AccessMainApprovalReadBoundary(app);
    (app.pm.get('workflow-approval') as PluginWorkflowApproval).options.snapshotReadGuard = () => {
      throw new Error('Startup snapshot read guard was replaced');
    };
    // Notifications are outside this read-boundary fixture; do not contact a provider.
    (app as any).messageManager = { sendMessage() {} };
    for (const id of ['H', 'B', 'C']) {
      await app.db.getRepository('tenants').create({ values: { id, name: id, enabled: true } });
    }
    await app.db.getRepository('roles').create({
      values: { name: account, strategy: { actions: ['view', 'create', 'update'] }, snippets: [] },
    });
    const user = await app.db.getRepository('users').create({
      values: { username: account, password, roles: [account], tenants: ['B'], defaultTenantId: 'B' },
    });
    userId = user.get('id');
    const signedIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({ account, password });
    expect(signedIn.status).toBe(200);
    expect(String(signedIn.body.data.user.id)).toBe(String(userId));
    expect(signedIn.body.data.user.hasPassword).toBe(true);
    token = signedIn.body.data.token;
    expect(token).toEqual(expect.any(String));
    const stored = await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: 'approvalSnapshotDocuments',
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
    identity = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName: stored.get('name') };
    const source = await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: 'approvalSnapshotSources',
        tenancy: 'tenantScoped',
        timestamps: false,
        createdBy: false,
        updatedBy: false,
        fields: [
          { name: 'name', type: 'string' },
          { name: 'amount', type: 'integer' },
          { name: 'document', type: 'belongsTo', target: identity.collectionName, foreignKey: 'documentId' },
        ],
      },
    });
    sourceIdentity = { dataSourceKey: 'main', collectionKey: source.get('key'), collectionName: source.get('name') };
    const registry = new AccessMainRootResourceRegistry(app);
    await app.db.collection(accessConfigHistory).model.sync();
    await registry.store.save(identity, { ...configFor(ownerCondition), revision: 0, rules: [] }, { userId });
    const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
    unregister = adapter.register();
    registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) => registry.select(ctx, adapter, [...selectedKeys]));
  });

  beforeEach(async () => {
    selectedKeys.clear();
    guardMode = 'boundary';
    readCalls = 0;
    await app.db.getCollection(sourceIdentity.collectionName).model.destroy({ where: {}, hooks: false });
    const model = app.db.getCollection(identity.collectionName).model;
    await model.destroy({ where: {}, hooks: false });
    await model.bulkCreate([
      { id: 1, name: 'Owned H', amount: 100, tenantId: 'H' },
      { id: 2, name: 'Owned B', amount: 200, tenantId: 'B' },
      { id: 3, name: 'Owned C', amount: 300, tenantId: 'C' },
    ]);
    workflow = await app.db.getRepository('workflows').create({
      values: {
        title: 'Approval snapshot read',
        type: 'approval',
        enabled: true,
        config: { collection: identity.collectionName, summary: ['name', 'amount'], appends: [] },
      },
    });
    await workflow.createNode({
      type: 'approval',
      config: {
        assignees: [userId],
        negotiation: 0,
        order: false,
        branchMode: false,
        actions: [APPROVAL_ACTION_STATUS.APPROVED],
      },
    });
  });
  afterEach(async () => {
    await waitForWorkflowIdle(app);
    await workflow?.update({ enabled: false });
  });
  afterAll(async () => {
    unregister?.();
    await app?.destroy();
  });

  async function businessRows() {
    const result = {};
    for (const name of [identity.collectionName, sourceIdentity.collectionName]) {
      result[name] = await app.db.getCollection(name).model.findAll({ raw: true, order: [['id', 'ASC']] });
    }
    return result;
  }

  async function prepareApproval(data = {}, collectionName = workflow.config.collection) {
    const response = await agent()
      .resource('approvals')
      .create({
        values: {
          collectionName,
          data: { name: 'Initial B', amount: 200, ...data },
          status: APPROVAL_STATUS.SUBMITTED,
          workflowId: workflow.id,
          workflowKey: workflow.key,
        },
      });
    expect(response.status).toBe(200);
    let record;
    await waitForFastAssertion(async () => {
      record = await app.db.getRepository('approvalRecords').findOne({ filter: { approvalId: response.body.data.id } });
      expect(record?.get('status')).toBe(APPROVAL_ACTION_STATUS.PENDING);
    });
    await waitForWorkflowIdle(app);
    const initialJobs = await app.db.getRepository('jobs').find({ filter: { executionId: record.get('executionId') } });
    expect(initialJobs.map((job) => ({ status: job.get('status'), result: job.get('result') }))).toEqual([
      { status: JOB_STATUS.PENDING, result: null },
    ]);
    expect(record.get('userId')).toBe(userId);
    expect(record.get('tenantId')).toBe('B');
    expect(record.get('snapshot')).toMatchObject({ name: 'Initial B', amount: 200, tenantId: 'B' });
    const targetId = Number(response.body.data.dataKey);
    const updated = await agent()
      .resource(collectionName)
      .update({
        filterByTk: targetId,
        values: { name: 'Hidden B refreshed', amount: 275 },
      });
    expect(updated.status).toBe(200);
    return { record, targetId };
  }

  async function submit(record) {
    const response = await agent()
      .resource('approvalRecords')
      .submit({
        filterByTk: record.get('id'),
        values: { status: APPROVAL_ACTION_STATUS.APPROVED, data: {} },
      });
    expect(response.status).toBe(202);
    let job;
    await waitForFastAssertion(async () => {
      job = await app.db.getRepository('jobs').findOne({ filterByTk: record.get('jobId') });
      expect(job.get('status')).not.toBe(JOB_STATUS.PENDING);
    });
    await waitForWorkflowIdle(app);
    await record.reload();
    const detail = await agent()
      .resource('approvalRecords')
      .get({ filterByTk: record.get('id') });
    expect(detail.status).toBe(200);
    return { job, snapshot: record.get('snapshot'), detail: detail.body.data };
  }

  it('does not refresh a selected hidden business row into an assignee snapshot', async () => {
    const baseline = await prepareApproval();
    const old = await submit(baseline.record);
    expect(old.job.get('status')).toBe(JOB_STATUS.RESOLVED);
    expect(old.snapshot).toMatchObject({ name: 'Hidden B refreshed', amount: 275, tenantId: 'B' });
    expect(old.detail.snapshot).toMatchObject({ name: 'Hidden B refreshed', amount: 275, tenantId: 'B' });

    const protectedApproval = await prepareApproval();
    selectedKeys.add(identity.collectionKey);
    const direct = await agent().resource(identity.collectionName).list({ pageSize: 100 });
    expect(direct.status).toBe(200);
    expect(direct.body.data).toEqual([]);
    const before = await businessRows();
    const result = await submit(protectedApproval.record);
    expect({
      jobStatus: result.job.get('status'),
      snapshot: result.snapshot,
      exposed: result.detail.snapshot,
    }).toMatchObject({
      jobStatus: JOB_STATUS.ERROR,
      snapshot: { name: 'Initial B', amount: 200, tenantId: 'B' },
      exposed: { name: 'Initial B', amount: 200, tenantId: 'B' },
    });
    expect(result.job.get('result').message).toMatch(/selected access collections/i);
    expect(await businessRows()).toEqual(before);
    selectedKeys.clear();
    const restored = await prepareApproval();
    const allowed = await submit(restored.record);
    expect(allowed.job.get('status')).toBe(JOB_STATUS.RESOLVED);
    expect(allowed.snapshot).toMatchObject({ name: 'Hidden B refreshed', amount: 275, tenantId: 'B' });
  });

  it('refuses a fresh selected association append without retracting an earlier saved snapshot', async () => {
    await workflow.update({
      config: { collection: sourceIdentity.collectionName, summary: ['name'], appends: ['document'] },
    });
    const prepared = await prepareApproval({ documentId: 2 });
    expect(prepared.record.get('snapshot').document).toMatchObject({
      id: 2,
      name: 'Owned B',
      amount: 200,
      tenantId: 'B',
    });
    expect(
      (
        await agent()
          .resource(identity.collectionName)
          .update({
            filterByTk: 2,
            values: { name: 'Hidden target refreshed', amount: 325 },
          })
      ).status,
    ).toBe(200);
    selectedKeys.add(identity.collectionKey);
    const before = await businessRows();
    const result = await submit(prepared.record);
    expect(result.job.get('status')).toBe(JOB_STATUS.ERROR);
    expect(result.job.get('result').message).toMatch(/selected access collections/i);
    expect(result.snapshot).toMatchObject({ name: 'Initial B', amount: 200, documentId: 2, tenantId: 'B' });
    expect(result.snapshot.document).toBeUndefined();
    expect(JSON.stringify(result.detail)).not.toContain('Hidden target refreshed');
    const saved = await app.db
      .getRepository('approvalExecutions')
      .findOne({ filterByTk: prepared.record.get('approvalExecutionId') });
    expect(saved.get('snapshot').document).toMatchObject({ name: 'Owned B', amount: 200, tenantId: 'B' });
    expect(await businessRows()).toEqual(before);
    selectedKeys.clear();
    const restored = await prepareApproval({ documentId: 2 });
    const allowed = await submit(restored.record);
    expect(allowed.job.get('status')).toBe(JOB_STATUS.RESOLVED);
    expect(allowed.detail.snapshot.document).toMatchObject({
      id: 2,
      name: 'Hidden target refreshed',
      amount: 325,
      tenantId: 'B',
    });
  });

  it.each(['async', 'invalid', 'throw'] as const)('does not swallow a %s snapshot guard rejection', async (mode) => {
    const prepared = await prepareApproval();
    const before = await businessRows();
    guardMode = mode;
    const result = await submit(prepared.record);
    expect(result.job.get('status')).toBe(JOB_STATUS.ERROR);
    expect(result.job.get('result').message).toMatch(
      mode === 'throw' ? /Snapshot read rejected/ : /must return undefined synchronously/,
    );
    expect(result.snapshot).toMatchObject({ name: 'Initial B', amount: 200, tenantId: 'B' });
    expect(result.detail.snapshot).toEqual(result.snapshot);
    expect(await businessRows()).toEqual(before);
  });

  it('retains scalar refreshes when only an unrelated collection is selected', async () => {
    const prepared = await prepareApproval();
    selectedKeys.add(sourceIdentity.collectionKey);
    const before = await businessRows();
    const result = await submit(prepared.record);
    expect(result.job.get('status')).toBe(JOB_STATUS.RESOLVED);
    expect(result.snapshot).toMatchObject({ name: 'Hidden B refreshed', amount: 275, tenantId: 'B' });
    expect(await businessRows()).toEqual(before);
  });

  it('rejects a different authenticated user before resuming or consulting the snapshot guard', async () => {
    const prepared = await prepareApproval();
    const otherAccount = 'approval-snapshot-outsider';
    await app.db.getRepository('users').create({
      values: { username: otherAccount, password, roles: [account], tenants: ['B'], defaultTenantId: 'B' },
    });
    const signedIn = await app
      .agent()
      .post('/auth:signIn')
      .set('X-Authenticator', 'basic')
      .send({ account: otherAccount, password });
    expect(signedIn.status).toBe(200);
    const before = prepared.record.toJSON();
    const businessBefore = await businessRows();
    const response = await agent(signedIn.body.data.token)
      .resource('approvalRecords')
      .submit({
        filterByTk: prepared.record.get('id'),
        values: { status: APPROVAL_ACTION_STATUS.APPROVED, data: {} },
      });
    expect(response.status).toBe(404);
    await waitForWorkflowIdle(app);
    await prepared.record.reload();
    expect(prepared.record.toJSON()).toEqual(before);
    expect(readCalls).toBe(0);
    expect(await businessRows()).toEqual(businessBefore);
  });

  it('validates startup callbacks and actual main collection bindings', () => {
    expect(() => captureApprovalSnapshotReadGuard(true as never)).toThrow(/must be a function/);
    const request = {
      dataSourceName: 'main',
      collectionName: identity.collectionName,
      collection: app.db.getCollection(identity.collectionName),
      params: {},
      context: {},
    };
    expect(() => boundary.assert({ ...request, collection: {} }, [identity])).toThrow(/target changed/);
    expect(() => boundary.assert(request, [identity, identity])).toThrow(/selection/);
    expect(() => boundary.assert(request, [{ ...identity, dataSourceKey: 'external' }])).toThrow(/selection/);
  });
});

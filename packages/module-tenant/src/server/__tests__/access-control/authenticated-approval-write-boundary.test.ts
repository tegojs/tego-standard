import { pathToFileURL } from 'node:url';
import { EXECUTION_STATUS } from '@tachybase/module-workflow';
import type { MockServer } from '@tachybase/test';

import { waitForFastAssertion, waitForWorkflowIdle } from '../../../../../module-workflow/src/server/__tests__/utils';
import { captureApprovalBusinessWriteGuard } from '../../../../../plugin-workflow-approval/src/server/business-write-guard';
import { APPROVAL_STATUS } from '../../../../../plugin-workflow-approval/src/server/constants/status';
import type PluginWorkflowApproval from '../../../../../plugin-workflow-approval/src/server/plugin';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import type { AccessCollectionIdentity } from '../../access-control/config-store';
import { AccessMainApprovalWriteBoundary } from '../../access-control/main-approval-write-boundary';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreFactoryEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreFactoryEntry)('authenticated approval business write boundaries', () => {
  let app: MockServer;
  let identity: AccessCollectionIdentity;
  let token: string;
  let workflow;
  let boundary: AccessMainApprovalWriteBoundary;
  let guardMode: 'boundary' | 'async' | 'invalid';
  let unregister: (() => void) | undefined;
  const selectedKeys = new Set<string>();
  const account = 'approval-business-participant';
  const password = 'approval-boundary-password';
  const agent = () =>
    app
      .agent()
      .set('Authorization', `Bearer ${token}`)
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
            businessWriteGuard: (request) => {
              expect(Object.isFrozen(request)).toBe(true);
              expect(() => app.pm.get('workflow').captureDataOperationAuthority(request)).toThrow(/authority/i);
              if (guardMode === 'async') return Promise.resolve();
              if (guardMode === 'invalid') return true;
              return boundary.assert(request, selectedKeys.size ? [identity] : []);
            },
          },
        ],
      ],
    });
    boundary = new AccessMainApprovalWriteBoundary(app);
    (app.pm.get('workflow-approval') as PluginWorkflowApproval).options.businessWriteGuard = () => {
      throw new Error('Startup approval guard was replaced');
    };
    for (const id of ['H', 'B', 'C']) {
      await app.db.getRepository('tenants').create({ values: { id, name: id, enabled: true } });
    }
    await app.db.getRepository('roles').create({
      values: { name: account, strategy: { actions: ['view', 'create', 'update'] }, snippets: [] },
    });
    const user = await app.db.getRepository('users').create({
      values: { username: account, password, roles: [account], tenants: ['B'], defaultTenantId: 'B' },
    });
    const signedIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({ account, password });
    expect(signedIn.status).toBe(200);
    expect(String(signedIn.body.data.user.id)).toBe(String(user.get('id')));
    expect(signedIn.body.data.user.hasPassword).toBe(true);
    token = signedIn.body.data.token;
    expect(token).toEqual(expect.any(String));
    const stored = await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: 'approvalBoundaryDocuments',
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
    await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: 'approvalBoundaryLegacy',
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
    const registry = new AccessMainRootResourceRegistry(app);
    await app.db.collection(accessConfigHistory).model.sync();
    await registry.store.save(
      identity,
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
    const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
    unregister = adapter.register();
    registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) => registry.select(ctx, adapter, [...selectedKeys]));
  });

  beforeEach(async () => {
    selectedKeys.clear();
    guardMode = 'boundary';
    await app.db.getCollection('approvalBoundaryLegacy').model.destroy({ where: {}, hooks: false });
    const model = app.db.getCollection(identity.collectionName).model;
    await model.destroy({ where: {}, hooks: false });
    await model.bulkCreate([
      { id: 1, name: 'Owned H', amount: 100, tenantId: 'H' },
      { id: 2, name: 'Owned B', amount: 200, tenantId: 'B' },
      { id: 3, name: 'Owned C', amount: 300, tenantId: 'C' },
    ]);
    workflow = await app.db.getRepository('workflows').create({
      values: {
        title: 'Approval write boundary',
        type: 'approval',
        enabled: true,
        config: { collection: identity.collectionName, summary: ['name', 'amount'], appends: [] },
      },
    });
    await workflow.createNode({ type: 'echo' });
  });
  afterEach(async () => {
    await waitForWorkflowIdle(app);
    await workflow?.update({ enabled: false });
  });
  afterAll(async () => {
    unregister?.();
    await app?.destroy();
  });

  async function rows() {
    return (await app.db.getCollection(identity.collectionName).model.findAll({ order: [['id', 'ASC']] })).map((row) =>
      row.get(),
    );
  }
  async function auditRows() {
    const result = {};
    for (const name of ['approvals', 'approvalExecutions', 'executions', 'jobs']) {
      result[name] = await app.db.getCollection(name).model.findAll({ raw: true, order: [['id', 'ASC']] });
    }
    return result;
  }
  async function createApproval(name: string, data = {}, collectionName = identity.collectionName) {
    const response = await agent()
      .resource('approvals')
      .create({
        values: {
          collectionName,
          data: { name, amount: 5, ...data },
          status: APPROVAL_STATUS.DRAFT,
          workflowId: workflow.id,
          workflowKey: workflow.key,
        },
      });
    if (response.status === 200) {
      await waitForFastAssertion(async () => {
        const execution = await app.db.getRepository('executions').findOne({
          filter: { workflowId: workflow.id, 'context.approvalId': response.body.data.id },
        });
        expect(execution?.get('status')).toBe(EXECUTION_STATUS.CANCELED);
      });
      await waitForWorkflowIdle(app);
    }
    return response;
  }

  it('does not create a selected business record through an approval draft', async () => {
    const baseline = await createApproval('Unselected draft');
    expect(baseline.status).toBe(200);
    await waitForWorkflowIdle(app);
    const before = await rows();
    expect(before.at(-1)).toMatchObject({ name: 'Unselected draft', amount: 5, tenantId: 'B' });
    const approvals = app.db.getCollection('approvals').model;
    const beforeApprovals = await approvals.findAll({ raw: true, order: [['id', 'ASC']] });
    const beforeAudit = await auditRows();
    selectedKeys.add(identity.collectionKey);
    const direct = await agent()
      .resource(identity.collectionName)
      .create({ values: { name: 'Blocked', amount: 5 } });
    expect(direct.status).toBe(403);
    expect(await rows()).toEqual(before);
    const response = await createApproval('Must not persist');
    expect({ status: response.status, rows: await rows() }).toEqual({ status: 400, rows: before });
    expect(await approvals.findAll({ raw: true, order: [['id', 'ASC']] })).toEqual(beforeApprovals);
    expect(response.body.errors[0].message).toMatch(/Selected approval business writes/);
    expect(await auditRows()).toEqual(beforeAudit);
    selectedKeys.clear();
    expect((await createApproval('Must not persist')).status).toBe(200);
    expect((await rows()).at(-1)).toMatchObject({ name: 'Must not persist', amount: 5, tenantId: 'B' });
  });

  it('does not update an excluded business record through its existing approval draft', async () => {
    const baseline = await createApproval('Unselected draft');
    expect(baseline.status).toBe(200);
    await waitForWorkflowIdle(app);
    const approval = await app.db.getRepository('approvals').findOne({
      filter: { workflowId: workflow.id, collectionName: identity.collectionName },
    });
    expect(approval.get('tenantId')).toBe('B');
    const targetId = Number(approval.get('dataKey'));
    const before = await rows();
    const approvalBefore = approval.toJSON();
    const beforeAudit = await auditRows();
    selectedKeys.add(identity.collectionKey);
    const direct = await agent()
      .resource(identity.collectionName)
      .update({ filterByTk: targetId, values: { name: 'Blocked' } });
    expect(direct.status).toBe(403);
    expect(await rows()).toEqual(before);
    const request = {
      filterByTk: approval.get('id'),
      values: {
        collectionName: identity.collectionName,
        data: { id: targetId, name: 'Must not persist', amount: 5 },
        status: APPROVAL_STATUS.DRAFT,
        summaryConfig: ['name', 'amount'],
      },
    };
    const response = await agent().resource('approvals').update(request);
    expect({ status: response.status, rows: await rows() }).toEqual({ status: 400, rows: before });
    await approval.reload();
    expect(approval.toJSON()).toEqual(approvalBefore);
    expect(response.body.errors[0].message).toMatch(/Selected approval business writes/);
    expect(await auditRows()).toEqual(beforeAudit);
    selectedKeys.clear();
    expect((await agent().resource('approvals').update(request)).status).toBe(200);
    expect(await rows()).toEqual(
      before.map((row) => (row.id === targetId ? { ...row, name: 'Must not persist' } : row)),
    );
  });

  it.each(['create', 'update'] as const)(
    'rejects asynchronous and invalid %s guards before any business write',
    async (action) => {
      const baseline = await createApproval('Existing draft');
      expect(baseline.status).toBe(200);
      const before = await rows();
      const audit = await auditRows();
      const approval = baseline.body.data;
      for (const mode of ['async', 'invalid'] as const) {
        guardMode = mode;
        const response =
          action === 'create'
            ? await createApproval('Must not persist')
            : await agent()
                .resource('approvals')
                .update({
                  filterByTk: approval.id,
                  values: {
                    collectionName: identity.collectionName,
                    data: { id: Number(approval.dataKey), name: 'Must not persist', amount: 5 },
                    status: APPROVAL_STATUS.DRAFT,
                    summaryConfig: ['name'],
                  },
                });
        expect(response.status).toBe(500);
        expect(response.body.errors[0].message).toMatch(/must return undefined synchronously/);
        expect(await rows()).toEqual(before);
        expect(await auditRows()).toEqual(audit);
      }
    },
  );

  it('rejects non-function startup guards', () => {
    expect(() => captureApprovalBusinessWriteGuard(true as never)).toThrow(/must be a function/);
  });

  it.each(['create', 'update', 'summary'] as const)(
    'rejects an unselected approval %s crossing a selected target',
    async (action) => {
      const collectionName = 'approvalBoundaryLegacy';
      await workflow.update({ config: { collection: collectionName, summary: ['name'], appends: [] } });
      const baseline = await createApproval('Legacy draft', {}, collectionName);
      expect(baseline.status).toBe(200);
      if (action === 'summary') {
        await workflow.update({ config: { collection: collectionName, summary: ['document.name'], appends: [] } });
      }
      const model = app.db.getCollection(collectionName).model;
      const before = await model.findAll({ raw: true, order: [['id', 'ASC']] });
      const targetBefore = await rows();
      const audit = await auditRows();
      const request = {
        filterByTk: baseline.body.data.id,
        values: {
          collectionName,
          data: { id: Number(baseline.body.data.dataKey), name: 'Changed legacy', amount: 5, documentId: 2 },
          status: APPROVAL_STATUS.DRAFT,
          summaryConfig: ['name'],
        },
      };
      const submit = () =>
        action === 'update'
          ? agent().resource('approvals').update(request)
          : createApproval('Changed legacy', action === 'summary' ? {} : { documentId: 2 }, collectionName);
      selectedKeys.add(identity.collectionKey);
      const response = await submit();
      expect(response.status).toBe(400);
      expect(response.body.errors[0].message).toMatch(/selected access collections/i);
      expect(await model.findAll({ raw: true, order: [['id', 'ASC']] })).toEqual(before);
      expect(await rows()).toEqual(targetBefore);
      expect(await auditRows()).toEqual(audit);
      selectedKeys.clear();
      expect((await submit()).status).toBe(200);
      const actual = await model.findAll({ raw: true, order: [['id', 'ASC']] });
      expect(actual.at(-1)).toMatchObject({
        name: 'Changed legacy',
        amount: 5,
        tenantId: 'B',
        documentId: action === 'summary' ? null : 2,
      });
      expect(await rows()).toEqual(targetBefore);
    },
  );
});

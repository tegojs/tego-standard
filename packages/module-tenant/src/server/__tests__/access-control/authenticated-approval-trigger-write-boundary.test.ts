import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { waitForFastAssertion, waitForWorkflowIdle } from '../../../../../module-workflow/src/server/__tests__/utils';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import type { AccessCollectionIdentity } from '../../access-control/config-store';
import { AccessMainApprovalWriteBoundary } from '../../access-control/main-approval-write-boundary';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated approval workflow trigger write boundary', () => {
  // A workflow resource trigger must not skip the approval business write veto.
  // workflows 资源触发审批新增时，不得跳过业务写入否决边界。
  it('rejects a selected business create before direct approval triggering writes any row', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    let boundary: AccessMainApprovalWriteBoundary;
    let identity: AccessCollectionIdentity;
    let selected = false;
    const role = 'approval-direct-trigger-member';
    const password = 'approval-direct-trigger-password';
    const collectionName = 'approvalDirectTriggerTasks';
    try {
      const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
      app = await createTenantApp({
        aclFactory: createACL,
        database: { dialect: 'sqlite', storage: ':memory:' },
        extraPlugins: [
          'workflow',
          [
            'workflow-approval',
            { businessWriteGuard: (request) => boundary.assert(request, selected ? [identity] : []) },
          ],
        ],
      });
      boundary = new AccessMainApprovalWriteBoundary(app);
      app.pm.get('workflow-approval').options.businessWriteGuard = () => {
        throw new Error('A later options replacement must not replace the captured guard');
      };
      await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
      await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
      const user = await app.db.getRepository('users').create({
        values: { username: role, password, roles: [role], tenants: ['B'], defaultTenantId: 'B' },
      });
      const stored = await app.db.getRepository('collections').create({
        context: {},
        values: {
          name: collectionName,
          tenancy: 'tenantScoped',
          timestamps: false,
          createdBy: false,
          updatedBy: false,
          fields: [{ name: 'name', type: 'string' }],
        },
      });
      const resource = await app.db.getRepository('dataSourcesRolesResources').create({
        values: {
          dataSourceKey: 'main',
          roleName: role,
          name: collectionName,
          usingActionsConfig: true,
          actions: [
            { name: 'list', fields: ['id', 'name', 'tenantId'] },
            { name: 'create', fields: ['name'] },
          ],
        },
      });
      const actions = await app.db.getRepository('dataSourcesRolesResources.actions', resource.get('id')).find({});
      expect(
        actions
          .map((action) => ({ name: action.get('name'), fields: action.get('fields') }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ).toEqual([
        { name: 'create', fields: ['name'] },
        { name: 'list', fields: ['id', 'name', 'tenantId'] },
      ]);
      identity = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName };
      const registry = new AccessMainRootResourceRegistry(app);
      await app.db.collection(accessConfigHistory).model.sync();
      await registry.store.save(
        identity,
        { ...configFor(ownerCondition), revision: 0, rules: [] },
        { userId: user.id },
      );
      const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
      unregister = adapter.register();
      registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
        registry.select(ctx, adapter, selected ? [identity.collectionKey] : []),
      );
      const workflow = await app.db.getRepository('workflows').create({
        values: {
          title: 'Direct approval trigger',
          type: 'approval',
          enabled: true,
          config: { collection: collectionName, summary: [], appends: [] },
        },
      });
      await workflow.createNode({ type: 'end', config: {} });
      const signedIn = await app
        .agent()
        .post('/auth:signIn')
        .set('X-Authenticator', 'basic')
        .send({ account: role, password });
      expect(signedIn.status).toBe(200);
      expect(signedIn.body.data.user).toMatchObject({ id: user.id, hasPassword: true });
      const token = signedIn.body.data.token;
      expect(token).toEqual(expect.any(String));
      const agent = () =>
        app.agent().set('Authorization', `Bearer ${token}`).set('X-Authenticator', 'basic').set('X-Role', role);
      const checked = await agent().get('/auth:check');
      expect(checked.status).toBe(200);
      expect(checked.body.data.id).toBe(user.id);
      const model = app.db.getCollection(collectionName).model;
      const rows = () => model.findAll({ raw: true, order: [['id', 'ASC']] });
      expect(await rows()).toEqual([]);
      selected = true;
      const direct = await agent()
        .resource(collectionName)
        .create({ values: { name: 'Direct denied' } });
      expect(direct.status).toBe(403);
      expect(await rows()).toEqual([]);
      const trigger = (name: string) =>
        agent().resource('workflows').trigger({ triggerWorkflows: workflow.key, values: { name } });
      selected = false;
      const baseline = await trigger('Unselected draft');
      expect(baseline.status).toBe(202);
      await waitForFastAssertion(async () => expect(await app.db.getRepository('approvals').count()).toBe(1));
      await waitForFastAssertion(async () => {
        const approval = await app.db.getRepository('approvals').findOne({});
        expect(approval.get('status')).toBe(4);
      });
      await waitForWorkflowIdle(app);
      expect(await rows()).toEqual([{ id: 1, name: 'Unselected draft', tenantId: 'B' }]);
      const approvalsBefore = await app.db.getCollection('approvals').model.findAll({ raw: true });
      const executionsBefore = await app.db.getCollection('executions').model.findAll({ raw: true });
      selected = true;
      const listed = await agent().resource(collectionName).list();
      expect(listed.status).toBe(200);
      expect(listed.body.data).toEqual([]);
      const denied = await trigger('Selected draft');
      await waitForWorkflowIdle(app);
      expect({ status: denied.status, rows: await rows() }).toEqual({
        status: 400,
        rows: [{ id: 1, name: 'Unselected draft', tenantId: 'B' }],
      });
      expect(await app.db.getCollection('approvals').model.findAll({ raw: true })).toEqual(approvalsBefore);
      expect(await app.db.getCollection('executions').model.findAll({ raw: true })).toEqual(executionsBefore);
      selected = false;
      const recovered = await trigger('Unselected again');
      expect(recovered.status).toBe(202);
      await waitForFastAssertion(async () => expect(await app.db.getRepository('approvals').count()).toBe(2));
      await waitForFastAssertion(async () => {
        const approval = await app.db.getRepository('approvals').findOne({ filter: { dataKey: '2' } });
        expect(approval.get('status')).toBe(4);
      });
      await waitForWorkflowIdle(app);
      expect(await rows()).toEqual([
        { id: 1, name: 'Unselected draft', tenantId: 'B' },
        { id: 2, name: 'Unselected again', tenantId: 'B' },
      ]);
    } finally {
      if (app) await waitForWorkflowIdle(app);
      unregister?.();
      await app?.destroy();
    }
  });
});

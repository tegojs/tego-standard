import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import WorkflowPlugin, { EXECUTION_STATUS } from '../../../../../module-workflow/src/server';
import CollectionTrigger, {
  type WorkflowCollectionReadRequest,
} from '../../../../../module-workflow/src/server/triggers/CollectionTrigger';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import type { AccessCollectionIdentity } from '../../access-control/config-store';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { AccessMainWorkflowCollectionReadBoundary } from '../../access-control/main-workflow-collection-read-boundary';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreFactoryEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreFactoryEntry)('authenticated collection trigger read boundary', () => {
  let app: MockServer;
  let plugin: WorkflowPlugin;
  let boundary: AccessMainWorkflowCollectionReadBoundary;
  let identity: AccessCollectionIdentity;
  let sourceIdentity: AccessCollectionIdentity;
  let captured: WorkflowCollectionReadRequest | undefined;
  let guardMode: 'normal' | 'async' | 'invalid' | 'throw';
  let token: string;
  let userId: number;
  let workflow;
  let unregister: () => void;
  const selectedKeys = new Set<string>();
  const role = 'collection-trigger-business-member';
  const password = 'collection-trigger-boundary-password';
  const sourceName = 'collectionTriggerSources';
  const targetName = 'collectionTriggerDocuments';
  const agent = (roleName = role) =>
    app
      .agent()
      .set('Authorization', `Bearer ${token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', roleName)
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
            collectionReadGuard: (request) => {
              captured = request;
              expect(Object.isFrozen(request)).toBe(true);
              expect(() => plugin.captureDataOperationAuthority(request)).toThrow(/authority is unavailable/);
              if (guardMode === 'async') return Promise.resolve() as never;
              if (guardMode === 'invalid') return false as never;
              if (guardMode === 'throw') throw new Error('Collection read guard refused');
              return boundary.assert(
                request,
                [identity, sourceIdentity].filter((item) => selectedKeys.has(item.collectionKey)),
              );
            },
          },
        ],
      ],
    });
    plugin = app.pm.get('workflow') as WorkflowPlugin;
    boundary = new AccessMainWorkflowCollectionReadBoundary(app);
    plugin.options.collectionReadGuard = () => {
      throw new Error('Options must not replace the captured guard');
    };
    for (const id of ['H', 'B', 'C'])
      await app.db.getRepository('tenants').create({ values: { id, name: id, enabled: true } });
    await app.db.getRepository('roles').create({
      values: { name: role, strategy: { actions: ['view', 'update', 'create'] }, snippets: [] },
    });
    await app.db.getRepository('roles').create({
      values: { name: 'collection-trigger-read-only', strategy: { actions: ['view'] }, snippets: [] },
    });
    const user = await app.db.getRepository('users').create({
      values: {
        username: role,
        password,
        roles: [role, 'collection-trigger-read-only'],
        tenants: ['B'],
        defaultTenantId: 'B',
      },
    });
    userId = user.get('id');
    const target = await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: targetName,
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
    identity = { dataSourceKey: 'main', collectionKey: target.get('key'), collectionName: targetName };
    await app.db.getCollection(targetName).model.bulkCreate([
      { id: 1, name: 'Owned H', amount: 100, tenantId: 'H' },
      { id: 2, name: 'Hidden B', amount: 200, tenantId: 'B' },
      { id: 3, name: 'Owned C', amount: 300, tenantId: 'C' },
    ]);
    const source = await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: sourceName,
        tenancy: 'tenantScoped',
        timestamps: false,
        createdBy: false,
        updatedBy: false,
        fields: [
          { name: 'name', type: 'string' },
          { name: 'documentId', type: 'integer', defaultValue: 2 },
          { name: 'document', type: 'belongsTo', target: targetName, foreignKey: 'documentId' },
        ],
      },
    });
    sourceIdentity = { dataSourceKey: 'main', collectionKey: source.get('key'), collectionName: sourceName };
    await app.db
      .getCollection(sourceName)
      .model.bulkCreate([{ id: 1, name: 'Source B', documentId: 2, tenantId: 'B' }]);
    await app.db.collection(accessConfigHistory).model.sync();
    const registry = new AccessMainRootResourceRegistry(app);
    await registry.store.save(identity, { ...configFor(ownerCondition), revision: 0, rules: [] }, { userId });
    const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
    unregister = adapter.register();
    registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) => registry.select(ctx, adapter, [...selectedKeys]));
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
  });

  beforeEach(async () => {
    guardMode = 'normal';
    captured = undefined;
    selectedKeys.clear();
    selectedKeys.add(identity.collectionKey);
    workflow = await app.db.getRepository('workflows').create({
      values: {
        title: 'Authenticated collection trigger read boundary',
        type: 'collection',
        enabled: true,
        sync: true,
        config: { collection: sourceName, mode: 2, appends: ['document'] },
      },
    });
    await workflow.createNode({ type: 'end', config: {} });
  });
  afterEach(async () => {
    await workflow?.update({ enabled: false });
  });
  afterAll(async () => {
    unregister?.();
    await app?.destroy();
  });

  async function rows(name: string) {
    return app.db.getCollection(name).model.findAll({ order: [['id', 'ASC']], raw: true });
  }

  it('refuses hidden association expansion caused only by a persisted collection workflow', async () => {
    const targets = await rows(targetName);
    expect(targets).toEqual([
      { id: 1, name: 'Owned H', amount: 100, tenantId: 'H' },
      { id: 2, name: 'Hidden B', amount: 200, tenantId: 'B' },
      { id: 3, name: 'Owned C', amount: 300, tenantId: 'C' },
    ]);
    const request = (name = 'Scalar update') =>
      agent().resource(sourceName).update({ filterByTk: 1, values: { name } });
    selectedKeys.clear();
    expect((await request()).status).toBe(200);
    const [baseline] = await workflow.getExecutions();
    expect(baseline.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(baseline.context.data.document).toEqual({ id: 2, name: 'Hidden B', amount: 200, tenantId: 'B' });
    expect(baseline.tenantId).toBe('B');
    expect(baseline.authContext).toEqual({ currentRole: role, currentUserId: userId });
    selectedKeys.add(identity.collectionKey);
    const direct = await agent().resource(targetName).list();
    expect(direct.status).toBe(200);
    expect(direct.body.data).toEqual([]);
    const before = await rows(sourceName);
    const executions = await workflow.countExecutions();
    const denied = await request('Denied scalar update');
    const newExecutions = (await workflow.getExecutions()).filter((execution) => execution.id !== baseline.id);
    expect({
      status: denied.status,
      sources: await rows(sourceName),
      executions: await workflow.countExecutions(),
      disclosed: newExecutions.map((execution) => execution.context.data.document),
    }).toEqual({ status: 400, sources: before, executions, disclosed: [] });
    expect(await rows(targetName)).toEqual(targets);
    expect(denied.body.errors[0].message).toMatch(/Legacy reads of selected access collections/);
    selectedKeys.clear();
    expect((await request('Restored scalar update')).status).toBe(200);
    expect(await workflow.countExecutions()).toBe(executions + 1);
    expect(await rows(targetName)).toEqual(targets);
  });

  async function businessRows() {
    return { sources: await rows(sourceName), targets: await rows(targetName) };
  }

  async function executionRows() {
    return {
      executions: await app.db.getCollection('executions').model.findAll({ order: [['id', 'ASC']], raw: true }),
      jobs: await app.db.getCollection('jobs').model.findAll({ order: [['id', 'ASC']], raw: true }),
    };
  }

  it('refuses association predicates before condition SQL and restores the same persisted workflow when unselected', async () => {
    await workflow.update({
      config: { collection: sourceName, mode: 2, condition: { $and: [{ 'document.name': 'Hidden B' }] } },
    });
    selectedKeys.clear();
    const request = () =>
      agent()
        .resource(sourceName)
        .update({ filterByTk: 1, values: { name: 'Condition update' } });
    expect((await request()).status).toBe(200);
    expect(await workflow.countExecutions()).toBe(1);
    selectedKeys.add(identity.collectionKey);
    const before = await businessRows();
    const executions = await executionRows();
    expect((await request()).status).toBe(400);
    expect(await businessRows()).toEqual(before);
    expect(await executionRows()).toEqual(executions);
    selectedKeys.clear();
    expect((await request()).status).toBe(200);
    expect(await workflow.countExecutions()).toBe(2);
    expect(await rows(targetName)).toEqual(before.targets);
  });

  it('rolls back a scalar create whose default association is read by the event', async () => {
    await workflow.update({ config: { collection: sourceName, mode: 1, appends: ['document'] } });
    const request = () =>
      agent()
        .resource(sourceName)
        .create({ values: { name: 'Scalar creation' } });
    selectedKeys.clear();
    expect((await request()).status).toBe(200);
    const [baseline] = await workflow.getExecutions();
    expect(baseline.context.data.document).toEqual({ id: 2, name: 'Hidden B', amount: 200, tenantId: 'B' });
    expect(baseline.context.data.tenantId).toBe('B');
    selectedKeys.add(identity.collectionKey);
    const before = await businessRows();
    const executions = await executionRows();
    expect((await request()).status).toBe(400);
    expect(await businessRows()).toEqual(before);
    expect(await executionRows()).toEqual(executions);
    selectedKeys.clear();
    expect((await request()).status).toBe(200);
    expect(await workflow.countExecutions()).toBe(2);
    expect((await rows(sourceName)).at(-1)).toMatchObject({ name: 'Scalar creation', tenantId: 'B', documentId: 2 });
    expect(await rows(targetName)).toEqual(before.targets);
  });

  it('refuses reads before an asynchronous event enters the queue', async () => {
    await workflow.update({ sync: false });
    const before = await businessRows();
    const executions = await executionRows();
    const request = () =>
      agent()
        .resource(sourceName)
        .update({ filterByTk: 1, values: { name: 'Async update' } });
    expect((await request()).status).toBe(400);
    expect(await businessRows()).toEqual(before);
    expect(await executionRows()).toEqual(executions);
    selectedKeys.clear();
    expect((await request()).status).toBe(200);
    await vi.waitFor(
      async () => {
        const [execution] = await workflow.getExecutions();
        expect(execution?.status).toBe(EXECUTION_STATUS.RESOLVED);
        expect(execution.context.data.document).toEqual({ id: 2, name: 'Hidden B', amount: 200, tenantId: 'B' });
        expect(execution.tenantId).toBe('B');
        expect(execution.authContext).toEqual({ currentRole: role, currentUserId: userId });
      },
      { timeout: 10000, interval: 50 },
    );
    expect(await rows(targetName)).toEqual(before.targets);
  });

  it.each(['async', 'invalid', 'throw'] as const)('does not fall back after a %s guard', async (mode) => {
    guardMode = mode;
    const before = await businessRows();
    const executions = await executionRows();
    const response = await agent()
      .resource(sourceName)
      .update({ filterByTk: 1, values: { name: 'Must roll back' } });
    expect(response.status).toBe(500);
    expect(response.body.errors[0].message).toMatch(
      mode === 'throw' ? /Collection read guard refused/ : /must return undefined synchronously/,
    );
    expect(await businessRows()).toEqual(before);
    expect(await executionRows()).toEqual(executions);
    expect(captured.collection).toBe(app.db.getCollection(sourceName));
  });

  it('preserves the original update ACL before any event read', async () => {
    guardMode = 'throw';
    const before = await businessRows();
    const executions = await executionRows();
    const response = await agent('collection-trigger-read-only')
      .resource(sourceName)
      .update({ filterByTk: 1, values: { name: 'No ACL' } });
    expect(response.status).toBe(403);
    expect(captured).toBeUndefined();
    expect(await businessRows()).toEqual(before);
    expect(await executionRows()).toEqual(executions);
  });

  it('keeps event data without additional repository reads on its original path', async () => {
    await workflow.update({ config: { collection: sourceName, mode: 2 } });
    guardMode = 'throw';
    const targets = await rows(targetName);
    const response = await agent()
      .resource(sourceName)
      .update({ filterByTk: 1, values: { name: 'No lookup' } });
    expect(response.status).toBe(200);
    const [execution] = await workflow.getExecutions();
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(execution.context.data).toMatchObject({ name: 'No lookup', tenantId: 'B' });
    expect(execution.context.data.document).toBeUndefined();
    expect(captured).toBeUndefined();
    expect(await rows(targetName)).toEqual(targets);
  });

  it('keeps an unrelated selection on the scalar condition path', async () => {
    await workflow.update({
      config: { collection: sourceName, mode: 2, condition: { $and: [{ name: 'Scalar condition' }] } },
    });
    const targets = await rows(targetName);
    const response = await agent()
      .resource(sourceName)
      .update({ filterByTk: 1, values: { name: 'Scalar condition' } });
    expect(response.status).toBe(200);
    expect(await workflow.countExecutions()).toBe(1);
    expect(await rows(targetName)).toEqual(targets);
  });

  it('rejects non-function startup guards and changed collection bindings or ambiguous selections', async () => {
    expect(() => new CollectionTrigger({ options: { collectionReadGuard: true } } as never)).toThrow(
      /must be a function/,
    );
    const request = {
      dataSourceName: 'main',
      collectionName: sourceName,
      collection: app.db.getCollection(sourceName),
      params: { filter: { id: 1 } },
      context: {},
    };
    expect(() => boundary.assert(request, [sourceIdentity])).toThrow(/Legacy reads of selected access collections/);
    expect(() => boundary.assert({ ...request, collection: app.db.getCollection(targetName) }, [identity])).toThrow(
      /target changed/,
    );
    expect(() => boundary.assert(request, [identity, identity])).toThrow(/Invalid main collection-event/);
    expect(() => boundary.assert(request, [{ ...identity, dataSourceKey: 'external' }])).toThrow(
      /Invalid main collection-event/,
    );
  });
});

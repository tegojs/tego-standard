import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import SnapshotFieldPlugin from '../../../../../plugin-field-snapshot/src/server';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import type { AccessCollectionIdentity } from '../../access-control/config-store';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreFactoryEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreFactoryEntry)('authenticated snapshot read boundary', () => {
  let app: MockServer;
  let identity: AccessCollectionIdentity;
  let unconfigured: AccessCollectionIdentity;
  let token: string;
  let unregister: () => void;
  const selectedKeys = new Set<string>();
  const role = 'snapshot-business-member';
  const password = 'snapshot-boundary-password';
  const sourceName = 'snapshotBoundarySources';
  const targetName = 'snapshotBoundaryDocuments';
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
          SnapshotFieldPlugin,
          { name: 'field-snapshot', packageName: '@tachybase/plugin-field-snapshot', workspaceSource: true },
        ],
      ],
    });
    for (const id of ['H', 'B', 'C'])
      await app.db.getRepository('tenants').create({ values: { id, name: id, enabled: true } });
    await app.db.getRepository('roles').create({
      values: { name: role, strategy: { actions: ['view', 'create', 'update'] }, snippets: [] },
    });
    await app.db.getRepository('roles').create({
      values: { name: 'snapshot-no-create', strategy: { actions: ['view'] }, snippets: [] },
    });
    const user = await app.db.getRepository('users').create({
      values: { username: role, password, roles: [role, 'snapshot-no-create'], tenants: ['B'], defaultTenantId: 'B' },
    });
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
    const legacy = await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: 'snapshotLegacyDocuments',
        tenancy: 'tenantScoped',
        timestamps: false,
        createdBy: false,
        updatedBy: false,
        fields: [
          { name: 'name', type: 'string' },
          { name: 'secret', type: 'belongsTo', target: targetName, foreignKey: 'secretId' },
        ],
      },
    });
    unconfigured = { dataSourceKey: 'main', collectionKey: legacy.get('key'), collectionName: legacy.get('name') };
    await app.db
      .getCollection('snapshotLegacyDocuments')
      .model.bulkCreate([{ id: 2, name: 'Legacy B', secretId: 2, tenantId: 'B' }]);
    await createSource(sourceName, targetName);
    await createSource('snapshotNestedSources', 'snapshotLegacyDocuments', ['secret', 'notRegistered']);
    await createSource('snapshotUnrelatedSources', 'snapshotLegacyDocuments', ['notRegistered']);
    await createSource('snapshotInactiveSources', targetName, [], 'notRegistered');
    app.db.collection(accessConfigHistory);
    await app.db.getCollection('tenantAccessRevisions').model.sync();
    const registry = new AccessMainRootResourceRegistry(app);
    await registry.store.save(
      identity,
      { ...configFor(ownerCondition), revision: 0, rules: [] },
      { userId: user.get('id') },
    );
    const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
    unregister = adapter.register();
    registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) => registry.select(ctx, adapter, [...selectedKeys]));
    const signedIn = await app
      .agent()
      .post('/auth:signIn')
      .set('X-Authenticator', 'basic')
      .send({ account: role, password });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.data.user.id).toBe(user.get('id'));
    expect(signedIn.body.data.user.hasPassword).toBe(true);
    token = signedIn.body.data.token;
    expect(token).toEqual(expect.any(String));
  });

  afterAll(async () => {
    unregister?.();
    await app?.destroy();
  });

  beforeEach(() => {
    selectedKeys.clear();
    selectedKeys.add(identity.collectionKey);
  });

  async function createSource(name: string, target: string, appends: string[] = [], targetField = 'document') {
    await app.db.getRepository('collections').create({
      context: {},
      values: {
        name,
        tenancy: 'tenantScoped',
        timestamps: false,
        createdBy: false,
        updatedBy: false,
        fields: [
          { name: 'name', type: 'string' },
          { name: 'documentId', type: 'integer', defaultValue: 2 },
          { name: 'document', type: 'belongsTo', target, foreignKey: 'documentId' },
          { name: 'snapshot', type: 'snapshot', targetField, appends },
        ],
      },
    });
  }

  async function rows(name: string) {
    return app.db.getCollection(name).model.findAll({ order: [['id', 'ASC']], raw: true });
  }

  it('does not copy a selected hidden target through a default relationship during scalar creation', async () => {
    const targets = await rows(targetName);
    expect(targets).toEqual([
      { id: 1, name: 'Owned H', amount: 100, tenantId: 'H' },
      { id: 2, name: 'Hidden B', amount: 200, tenantId: 'B' },
      { id: 3, name: 'Owned C', amount: 300, tenantId: 'C' },
    ]);
    const request = () =>
      agent()
        .resource(sourceName)
        .create({ values: { name: 'Scalar creation' } });
    selectedKeys.clear();
    const baseline = await request();
    expect(baseline.status).toBe(200);
    const created = (await rows(sourceName))[0];
    expect(created).toMatchObject({
      name: 'Scalar creation',
      documentId: 2,
      tenantId: 'B',
    });
    expect(typeof created.snapshot === 'string' ? JSON.parse(created.snapshot) : created.snapshot).toEqual({
      collectionName: sourceName,
      data: { id: 2, name: 'Hidden B', amount: 200, tenantId: 'B' },
    });
    selectedKeys.add(identity.collectionKey);
    const direct = await agent().resource(targetName).list();
    expect(direct.status).toBe(200);
    expect(direct.body.data).toEqual([]);
    const before = await rows(sourceName);
    const denied = await request();
    expect({ status: denied.status, sources: await rows(sourceName) }).toEqual({ status: 400, sources: before });
    expect(denied.body.errors[0].message).toMatch(/Legacy reads of selected access collections/);
    expect(await rows(targetName)).toEqual(targets);
    selectedKeys.clear();
    const restored = await request();
    expect(restored.status).toBe(200);
    expect((await rows(sourceName)).length).toBe(before.length + 1);
    expect(await rows(targetName)).toEqual(targets);
  });

  it('rejects selected targets reached only through snapshot appends', async () => {
    const targets = await rows(targetName);
    const legacy = await rows('snapshotLegacyDocuments');
    const request = () =>
      agent()
        .resource('snapshotNestedSources')
        .create({ values: { name: 'Nested snapshot' } });
    selectedKeys.clear();
    const baseline = await request();
    expect(baseline.status).toBe(200);
    const created = (await rows('snapshotNestedSources'))[0];
    expect(JSON.parse(created.snapshot).data).toEqual({
      id: 2,
      name: 'Legacy B',
      secretId: 2,
      tenantId: 'B',
      secret: { id: 2, name: 'Hidden B', amount: 200, tenantId: 'B' },
    });
    selectedKeys.add(identity.collectionKey);
    const before = await rows('snapshotNestedSources');
    const denied = await request();
    expect(denied.status).toBe(400);
    expect(denied.body.errors[0].message).toMatch(/Legacy reads of selected access collections/);
    expect(await rows('snapshotNestedSources')).toEqual(before);
    expect(await rows(targetName)).toEqual(targets);
    expect(await rows('snapshotLegacyDocuments')).toEqual(legacy);
    selectedKeys.clear();
    expect((await request()).status).toBe(200);
    expect((await rows('snapshotNestedSources')).length).toBe(before.length + 1);
    expect(await rows(targetName)).toEqual(targets);
    expect(await rows('snapshotLegacyDocuments')).toEqual(legacy);
  });

  it('keeps unrelated selections and ignored appends on the original snapshot path', async () => {
    const targets = await rows(targetName);
    const legacy = await rows('snapshotLegacyDocuments');
    const response = await agent()
      .resource('snapshotUnrelatedSources')
      .create({ values: { name: 'Unrelated' } });
    expect(response.status).toBe(200);
    const [created] = await rows('snapshotUnrelatedSources');
    expect(created).toMatchObject({ name: 'Unrelated', tenantId: 'B', documentId: 2 });
    expect(JSON.parse(created.snapshot)).toEqual({
      collectionName: 'snapshotUnrelatedSources',
      data: { id: 2, name: 'Legacy B', secretId: 2, tenantId: 'B' },
    });
    expect(await rows(targetName)).toEqual(targets);
    expect(await rows('snapshotLegacyDocuments')).toEqual(legacy);
  });

  it('keeps a selected but unconfigured snapshot target on its original path', async () => {
    const targets = await rows(targetName);
    const legacy = await rows('snapshotLegacyDocuments');
    selectedKeys.clear();
    selectedKeys.add(unconfigured.collectionKey);
    const response = await agent()
      .resource('snapshotUnrelatedSources')
      .create({ values: { name: 'Unconfigured' } });
    expect(response.status).toBe(200);
    const created = (await rows('snapshotUnrelatedSources')).at(-1);
    expect(JSON.parse(created.snapshot).data).toEqual({ id: 2, name: 'Legacy B', secretId: 2, tenantId: 'B' });
    expect(created.tenantId).toBe('B');
    expect(await rows(targetName)).toEqual(targets);
    expect(await rows('snapshotLegacyDocuments')).toEqual(legacy);
  });

  it('does not treat a snapshot without its registered target field as a read', async () => {
    const response = await agent()
      .resource('snapshotInactiveSources')
      .create({ values: { name: 'No snapshot' } });
    expect(response.status).toBe(200);
    const [created] = await rows('snapshotInactiveSources');
    expect(created).toMatchObject({ name: 'No snapshot', documentId: 2, tenantId: 'B', snapshot: null });
  });

  it('does not rerun snapshot reads for an ordinary scalar update', async () => {
    selectedKeys.clear();
    const response = await agent()
      .resource(sourceName)
      .create({ values: { name: 'Before update' } });
    expect(response.status).toBe(200);
    const created = (await rows(sourceName)).at(-1);
    selectedKeys.add(identity.collectionKey);
    const targets = await rows(targetName);
    const updated = await agent()
      .resource(sourceName)
      .update({ filterByTk: created.id, values: { name: 'After update' } });
    expect(updated.status).toBe(200);
    expect((await rows(sourceName)).at(-1)).toEqual({ ...created, name: 'After update' });
    expect(await rows(targetName)).toEqual(targets);
  });

  it('requires the original create ACL before checking the snapshot boundary', async () => {
    const before = await rows(sourceName);
    const targets = await rows(targetName);
    const denied = await agent('snapshot-no-create')
      .resource(sourceName)
      .create({ values: { name: 'No create ACL' } });
    expect(denied.status).toBe(403);
    expect(await rows(sourceName)).toEqual(before);
    expect(await rows(targetName)).toEqual(targets);
  });
});

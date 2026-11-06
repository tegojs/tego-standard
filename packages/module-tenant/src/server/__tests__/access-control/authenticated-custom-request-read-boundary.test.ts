import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import CustomRequestPlugin from '../../../../../plugin-action-custom-request/src/server';
import { captureCurrentRecordReadGuard } from '../../../../../plugin-action-custom-request/src/server/current-record-read-guard';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import type { AccessCollectionIdentity } from '../../access-control/config-store';
import { AccessMainCustomRequestReadBoundary } from '../../access-control/main-custom-request-read-boundary';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreFactoryEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreFactoryEntry)('authenticated custom request read boundary', () => {
  let app: MockServer;
  let receiver: http.Server;
  let identity: AccessCollectionIdentity;
  let sourceIdentity: AccessCollectionIdentity;
  let token: string;
  let unregister: () => void;
  let boundary: AccessMainCustomRequestReadBoundary;
  let guardMode: 'boundary' | 'async' | 'invalid' | 'throw';
  const selectedKeys = new Set<string>();
  const received: unknown[] = [];
  const role = 'custom-request-business-member';
  const password = 'custom-request-boundary-password';
  const targetName = 'customRequestBoundaryDocuments';
  const sourceName = 'customRequestBoundarySources';
  const agent = () =>
    app
      .agent()
      .set('Authorization', `Bearer ${token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', role)
      .set('X-Tenant-Id', 'B');

  beforeAll(async () => {
    receiver = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      received.push(body);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const { port } = receiver.address() as AddressInfo;
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreFactoryEntry!).href);
    app = await createTenantApp({
      aclFactory: createACL,
      database: { dialect: 'sqlite', storage: ':memory:' },
      extraPlugins: [
        [
          CustomRequestPlugin,
          {
            name: 'custom-request',
            packageName: '@tachybase/plugin-action-custom-request',
            workspaceSource: true,
            currentRecordReadGuard: (request) => {
              expect(Object.isFrozen(request)).toBe(true);
              if (guardMode === 'async') return Promise.resolve();
              if (guardMode === 'invalid') return true;
              if (guardMode === 'throw') throw new Error('Current-record guard refused');
              boundary.assert(
                request,
                [identity, sourceIdentity].filter((entry) => selectedKeys.has(entry.collectionKey)),
              );
            },
          },
        ],
      ],
    });
    boundary = new AccessMainCustomRequestReadBoundary(app);
    (app.pm.get('custom-request') as CustomRequestPlugin).options.currentRecordReadGuard = () => {
      throw new Error('Startup guard was replaced');
    };
    for (const id of ['H', 'B', 'C'])
      await app.db.getRepository('tenants').create({ values: { id, name: id, enabled: true } });
    await app.db
      .getRepository('roles')
      .create({ values: { name: role, strategy: { actions: ['view'] }, snippets: [] } });
    const user = await app.db.getRepository('users').create({
      values: { username: role, password, roles: [role], tenants: ['B'], defaultTenantId: 'B' },
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
          { name: 'document', type: 'belongsTo', target: targetName, foreignKey: 'documentId' },
        ],
      },
    });
    sourceIdentity = { dataSourceKey: 'main', collectionKey: source.get('key'), collectionName: sourceName };
    await app.db
      .getCollection(sourceName)
      .model.bulkCreate([{ id: 1, name: 'Legacy source', documentId: 2, tenantId: 'B' }]);
    await app.db.getCollection(targetName).model.bulkCreate([
      { id: 1, name: 'Owned H', amount: 100, tenantId: 'H' },
      { id: 2, name: 'Hidden B', amount: 200, tenantId: 'B' },
      { id: 3, name: 'Owned C', amount: 300, tenantId: 'C' },
    ]);
    await app.db.getRepository('customRequests').create({
      values: {
        key: 'boundary',
        roles: [role],
        options: {
          collectionName: targetName,
          url: `http://127.0.0.1:${port}/capture`,
          method: 'POST',
          data: { record: '{{ currentRecord }}' },
        },
      },
    });
    for (const [key, collectionName, roles] of [
      ['source', sourceName, [role]],
      ['forbidden', targetName, ['root']],
    ] as const)
      await app.db.getRepository('customRequests').create({
        values: {
          key,
          roles,
          options: {
            collectionName,
            url: `http://127.0.0.1:${port}/capture`,
            method: 'POST',
            data: { record: '{{ currentRecord }}' },
          },
        },
      });
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

  beforeEach(() => {
    selectedKeys.clear();
    received.length = 0;
    guardMode = 'boundary';
  });

  async function businessRows() {
    const rows = {};
    for (const name of [sourceName, targetName])
      rows[name] = await app.db.getCollection(name).model.findAll({ order: [['id', 'ASC']], raw: true });
    return rows;
  }

  afterAll(async () => {
    unregister?.();
    await app?.destroy();
    if (receiver?.listening)
      await new Promise<void>((resolve, reject) => receiver.close((error) => (error ? reject(error) : resolve())));
  });

  it('does not interpolate a selected hidden current record into an outbound request', async () => {
    const before = await app.db.getCollection(targetName).model.findAll({ order: [['id', 'ASC']], raw: true });
    expect(before).toEqual([
      { id: 1, name: 'Owned H', amount: 100, tenantId: 'H' },
      { id: 2, name: 'Hidden B', amount: 200, tenantId: 'B' },
      { id: 3, name: 'Owned C', amount: 300, tenantId: 'C' },
    ]);
    const request = () =>
      agent()
        .resource('customRequests')
        .send({ filterByTk: 'boundary', values: { currentRecord: { id: 2 } } });
    const baseline = await request();
    expect(baseline.status).toBe(200);
    expect(received).toEqual([{ record: { id: 2, name: 'Hidden B', amount: 200, tenantId: 'B' } }]);
    selectedKeys.add(identity.collectionKey);
    const direct = await agent().resource(targetName).list();
    expect(direct.status).toBe(200);
    expect(direct.body.data).toEqual([]);
    const count = received.length;
    const denied = await request();
    expect({ status: denied.status, received: received.slice(count) }).toEqual({ status: 400, received: [] });
    expect(await app.db.getCollection(targetName).model.findAll({ order: [['id', 'ASC']], raw: true })).toEqual(before);
    selectedKeys.clear();
    expect((await request()).status).toBe(200);
    expect(received.at(-1)).toEqual({ record: { id: 2, name: 'Hidden B', amount: 200, tenantId: 'B' } });
  });

  it('refuses an unselected current record appending a selected hidden target', async () => {
    const before = await businessRows();
    const request = () =>
      agent()
        .resource('customRequests')
        .send({
          filterByTk: 'source',
          values: { currentRecord: { id: 1, appends: ['document'] } },
        });
    expect((await request()).status).toBe(200);
    expect(received).toEqual([
      {
        record: {
          id: 1,
          name: 'Legacy source',
          documentId: 2,
          tenantId: 'B',
          document: { id: 2, name: 'Hidden B', amount: 200, tenantId: 'B' },
        },
      },
    ]);
    selectedKeys.add(identity.collectionKey);
    expect((await request()).status).toBe(400);
    expect(received).toHaveLength(1);
    expect(await businessRows()).toEqual(before);
    selectedKeys.clear();
    expect((await request()).status).toBe(200);
    expect(received[1]).toEqual(received[0]);
  });

  it('keeps unrelated selections on the legacy scalar path with the captured startup guard', async () => {
    selectedKeys.add(sourceIdentity.collectionKey);
    const before = await businessRows();
    expect(
      (
        await agent()
          .resource('customRequests')
          .send({
            filterByTk: 'boundary',
            values: { currentRecord: { id: 2 } },
          })
      ).status,
    ).toBe(200);
    expect(received).toEqual([{ record: { id: 2, name: 'Hidden B', amount: 200, tenantId: 'B' } }]);
    expect(await businessRows()).toEqual(before);
  });

  it('preserves the configured role refusal before invoking the read guard', async () => {
    guardMode = 'throw';
    const before = await businessRows();
    const response = await agent()
      .resource('customRequests')
      .send({
        filterByTk: 'forbidden',
        values: { currentRecord: { id: 2 } },
      });
    expect(response.status).toBe(403);
    expect(received).toEqual([]);
    expect(await businessRows()).toEqual(before);
  });

  it.each(['async', 'invalid', 'throw'] as const)('does not fall back after a %s guard', async (mode) => {
    guardMode = mode;
    const before = await businessRows();
    const response = await agent()
      .resource('customRequests')
      .send({
        filterByTk: 'boundary',
        values: { currentRecord: { id: 2 } },
      });
    expect(response.status).toBe(500);
    expect(response.body.errors[0].message).toMatch(
      mode === 'throw' ? /Current-record guard refused/ : /must return undefined synchronously/,
    );
    expect(received).toEqual([]);
    expect(await businessRows()).toEqual(before);
  });

  it('keeps client-only template data when no current-record lookup is requested', async () => {
    selectedKeys.add(identity.collectionKey);
    guardMode = 'throw';
    const before = await businessRows();
    const response = await agent()
      .resource('customRequests')
      .send({
        filterByTk: 'boundary',
        values: { currentRecord: { data: { name: 'Client draft' } } },
      });
    expect(response.status).toBe(200);
    expect(received).toEqual([{ record: { name: 'Client draft' } }]);
    expect(await businessRows()).toEqual(before);
  });

  it('rejects non-function startup guards', () => {
    expect(() => captureCurrentRecordReadGuard(true as never)).toThrow(/must be a function/);
  });

  it('refuses changed database or collection bindings and ambiguous selections', async () => {
    const before = await businessRows();
    const request = {
      database: app.db,
      collectionName: targetName,
      collection: app.db.getCollection(targetName),
      params: { filterByTk: 2 },
      context: {},
    };
    expect(() => boundary.assert({ ...request, database: {} }, [identity])).toThrow(/target changed/);
    expect(() => boundary.assert({ ...request, collection: app.db.getCollection(sourceName) }, [identity])).toThrow(
      /target changed/,
    );
    expect(() => boundary.assert(request, [identity, identity])).toThrow(/Invalid main custom request/);
    expect(() => boundary.assert(request, [{ ...identity, dataSourceKey: 'external' }])).toThrow(
      /Invalid main custom request/,
    );
    expect(await businessRows()).toEqual(before);
    expect(received).toEqual([]);
  });
});

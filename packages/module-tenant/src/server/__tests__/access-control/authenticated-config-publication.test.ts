import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';
import { Application } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import type { AccessCollectionIdentity } from '../../access-control/config-store';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { isolatedPostgresDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;
const databaseUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

/** Real auth and separately loaded collection metadata/ACL/pools; no fixture identity middleware. */
describe.skipIf(!coreEntry)('authenticated access configuration publication', () => {
  const apps: MockServer[] = [];
  const unregister: Array<() => void> = [];
  const account = 'configuration-business-user';
  const password = 'configuration-test-password';
  let identity: AccessCollectionIdentity;
  let userId: number | string;
  type Instance = Awaited<ReturnType<typeof connect>>;
  let first: Instance;
  let second: Instance;

  async function connect(app: MockServer) {
    app.db.collection(accessConfigHistory);
    const registry = new AccessMainRootResourceRegistry(app);
    const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
    unregister.push(adapter.register());
    registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
      registry.select(ctx, adapter, [identity.collectionKey]),
    );
    const signedIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({ account, password });
    expect(signedIn.status).toBe(200);
    expect(String(signedIn.body.data.user.id)).toBe(String(userId));
    expect(signedIn.body.data.user.hasPassword).toBe(true);
    expect(signedIn.body.data.user).not.toHaveProperty('password');
    expect(signedIn.body.data.user).not.toHaveProperty('resetToken');
    const token = signedIn.body.data.token;
    expect(token).toEqual(expect.any(String));
    expect(token.length).toBeGreaterThan(0);
    const agent = () =>
      app
        .agent()
        .set('Authorization', `Bearer ${token}`)
        .set('X-Authenticator', 'basic')
        .set('X-Role', 'configuration-member')
        .set('X-Tenant-Id', 'B');
    const checked = await agent().get('/auth:check');
    expect(checked.status).toBe(200);
    expect(String(checked.body.data.id)).toBe(String(userId));
    return { app, store: registry.store, agent };
  }

  beforeAll(async () => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
    const isolated = databaseUrl ? isolatedPostgresDatabase(databaseUrl) : undefined;
    const database = isolated?.options ?? {
      dialect: 'sqlite' as const,
      storage: join(mkdtempSync(join(tmpdir(), 'tego-auth-config-')), 'database.sqlite'),
    };
    await isolated?.close();
    const app = await createTenantApp({ aclFactory: createACL, database });
    apps.push(app);
    for (const id of ['H', 'B', 'C']) {
      await app.db.getRepository('tenants').create({ values: { id, name: id, enabled: true } });
    }
    await app.db.getRepository('roles').create({
      values: { name: 'configuration-member', strategy: { actions: ['view', 'count', 'update'] } },
    });
    const user = await app.db.getRepository('users').create({
      values: { username: account, password, roles: ['configuration-member'], tenants: ['B'], defaultTenantId: 'B' },
    });
    userId = user.get('id');
    const collection = await app.db.getRepository('collections').create({
      values: {
        name: 'publication_documents',
        tenancy: 'tenantScoped',
        timestamps: false,
        createdBy: false,
        updatedBy: false,
        fields: [{ name: 'name', type: 'string' }],
      },
      context: {},
    });
    identity = { dataSourceKey: 'main', collectionKey: collection.get('key'), collectionName: 'publication_documents' };
    await app.db.getCollection(identity.collectionName).model.bulkCreate([
      { id: 1, tenantId: 'H', name: 'Visible' },
      { id: 2, tenantId: 'B', name: 'Owned' },
      { id: 3, tenantId: 'C', name: 'Other' },
    ]);
    app.db.collection(accessConfigHistory);
    await app.db.getCollection('tenantAccessRevisions').model.sync();
    const initial = configFor(ownerCondition);
    initial.rules.push({
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
    const initialStore = new AccessMainRootResourceRegistry(app).store;
    await initialStore.save(identity, { ...initial, revision: 0 }, { userId });
    const peer = await createTenantApp({
      name: 'access-publication-peer',
      skipInstall: true,
      aclFactory: createACL,
      database,
    });
    apps.push(peer);
    expect(peer.db).not.toBe(app.db);
    expect(peer.db.sequelize).not.toBe(app.db.sequelize);
    expect(peer.acl).not.toBe(app.acl);
    expect(peer.authManager).not.toBe(app.authManager);
    expect(peer.db.getCollection(identity.collectionName)).not.toBe(app.db.getCollection(identity.collectionName));
    expect(peer.db.getCollection(identity.collectionName).model).not.toBe(
      app.db.getCollection(identity.collectionName).model,
    );
    expect(peer.db.getCollection(identity.collectionName).options.key).toBe(identity.collectionKey);
    first = await connect(app);
    second = await connect(peer);
    expect(first.store).not.toBe(second.store);
  });

  afterAll(async () => {
    for (const release of unregister.splice(0)) release();
    const opened = apps.splice(0);
    try {
      for (const app of opened.slice(1)) await Application.prototype.destroy.call(app);
    } finally {
      await opened[0]?.destroy();
    }
  });

  const list = (instance: Instance) =>
    instance
      .agent()
      .resource(identity.collectionName)
      .list({ fields: ['id'], sort: ['id'] });
  const update = (instance: Instance) =>
    instance
      .agent()
      .resource(identity.collectionName)
      .update({ filterByTk: 2, values: { name: 'Changed' } });

  it.each(['first', 'second'] as const)(
    'refreshes authenticated reads and writes after a %s-instance save',
    async (publisher) => {
      const original = (await first.store.read(identity))!;
      try {
        for (const instance of [first, second]) {
          const response = await list(instance);
          expect(response.status).toBe(200);
          expect(response.body.data).toEqual([{ id: 1 }, { id: 2 }]);
          const counted = await instance.agent().resource(identity.collectionName).count();
          expect(counted.status).toBe(200);
          expect(counted.body.data).toBe(2);
        }
        const writer = publisher === 'first' ? first : second;
        const allowed = await update(writer);
        expect(allowed.status).toBe(200);
        for (const instance of [first, second]) {
          const record = await instance.app.db.getCollection(identity.collectionName).model.findByPk(2);
          expect(record?.get('name')).toBe('Changed');
          expect(record?.get('tenantId')).toBe('B');
        }
        const saved = await writer.store.save(identity, { ...original, rules: [] }, { userId });
        for (const instance of [first, second]) {
          const response = await list(instance);
          expect(response.status).toBe(200);
          expect(response.body.data).toEqual([]);
          const counted = await instance.agent().resource(identity.collectionName).count();
          expect(counted.status).toBe(200);
          expect(counted.body.data).toBe(0);
          const rejected = await update(instance);
          expect(rejected.status).toBe(403);
          expect(rejected.body).not.toHaveProperty('data');
          expect(await instance.store.read(identity)).toEqual(saved);
          const record = await instance.app.db.getCollection(identity.collectionName).model.findByPk(2);
          expect(record?.get('name')).toBe('Changed');
          expect(record?.get('tenantId')).toBe('B');
        }
      } finally {
        const latest = (await first.store.read(identity))!;
        await first.store.save(identity, { ...original, revision: latest.revision }, { userId });
        await first.app.db
          .getCollection(identity.collectionName)
          .model.update({ name: 'Owned' }, { where: { id: 2 }, hooks: false });
      }
    },
  );
});

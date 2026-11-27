import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import type { AccessCollectionIdentity } from '../../access-control/config-store';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreFactoryEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreFactoryEntry)('authenticated scalar foreign-key boundary', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;
  let token: string;
  const role = 'scalar-reference-member';
  const deniedRole = 'scalar-reference-denied';
  const password = 'scalar-reference-test-password';
  const sourceName = 'scalarReferenceSources';
  const targetName = 'scalarReferenceEmptyTargets';
  const agent = (roleName = role) =>
    app
      .agent()
      .set('Authorization', `Bearer ${token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', roleName)
      .set('X-Tenant-Id', 'B');

  beforeEach(async () => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreFactoryEntry!).href);
    app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
    await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
    await app.db.getRepository('roles').create({
      values: { name: role, strategy: { actions: ['create', 'update'] }, snippets: [] },
    });
    await app.db.getRepository('roles').create({
      values: { name: deniedRole, strategy: { actions: [] }, snippets: [] },
    });
    const user = await app.db.getRepository('users').create({
      values: { username: role, password, roles: [role, deniedRole], tenants: ['B'], defaultTenantId: 'B' },
    });
    const identities: AccessCollectionIdentity[] = [];
    for (const name of [targetName, sourceName]) {
      const collection = await app.db.getRepository('collections').create({
        context: {},
        values: {
          name,
          tenancy: 'tenantScoped',
          timestamps: false,
          createdBy: false,
          updatedBy: false,
          fields: [
            { name: 'name', type: 'string' },
            ...(name === sourceName
              ? [{ name: 'document', type: 'belongsTo', target: targetName, foreignKey: 'documentId' }]
              : []),
          ],
        },
      });
      identities.push({ dataSourceKey: 'main', collectionKey: collection.get('key'), collectionName: name });
    }
    await app.db
      .getCollection(sourceName)
      .model.bulkCreate([{ id: 1, name: 'Initial source', tenantId: 'B', documentId: null }]);
    await app.db.collection(accessConfigHistory).model.sync();
    const registry = new AccessMainRootResourceRegistry(app);
    for (const identity of identities) {
      const config = configFor(ownerCondition);
      await registry.store.save(
        identity,
        {
          ...config,
          revision: 0,
          rules:
            identity.collectionName === targetName
              ? []
              : config.rules.map((rule) => ({
                  ...rule,
                  subject: {
                    type: 'all',
                    children: [
                      {
                        type: 'compare',
                        operator: 'eq',
                        left: { type: 'context', path: 'user.id' },
                        right: { type: 'literal', value: String(user.get('id')) },
                      },
                      {
                        type: 'compare',
                        operator: 'eq',
                        left: { type: 'context', path: 'role.name' },
                        right: { type: 'literal', value: role },
                      },
                    ],
                  },
                })),
        },
        { userId: user.get('id') },
      );
    }
    const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
    unregister = adapter.register();
    registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
      registry.select(
        ctx,
        adapter,
        identities.map((identity) => identity.collectionKey),
      ),
    );
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

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
  });

  it.each(['create', 'update'] as const)(
    'rejects an authenticated %s through a physical foreign key before business repository access',
    async (action) => {
      const sources = app.db.getCollection(sourceName);
      const targets = app.db.getCollection(targetName);
      const request = (values: object, roleName = role) =>
        agent(roleName)
          .resource(sourceName)
          [action]({ ...(action === 'update' ? { filterByTk: 1 } : {}), values });
      const ordinary = await request({ name: 'Allowed scalar' });
      expect(ordinary.status).toBe(200);
      expect(await sources.model.findAll({ raw: true, order: [['id', 'ASC']] })).toEqual(
        action === 'create'
          ? [
              { id: 1, name: 'Initial source', tenantId: 'B', documentId: null },
              { id: 2, name: 'Allowed scalar', tenantId: 'B', documentId: null },
            ]
          : [{ id: 1, name: 'Allowed scalar', tenantId: 'B', documentId: null }],
      );
      const before = await sources.model.findAll({ raw: true, order: [['id', 'ASC']] });
      expect(await targets.model.findAll({ raw: true })).toEqual([]);
      const write = vi.spyOn(sources.repository, action);
      const sourceFind = vi.spyOn(sources.repository, 'find');
      const sourceFindOne = vi.spyOn(sources.repository, 'findOne');
      const targetFind = vi.spyOn(targets.repository, 'find');
      const targetFindOne = vi.spyOn(targets.repository, 'findOne');
      try {
        const denied = await request({ name: 'Rejected scalar reference', documentId: 1 });
        expect(denied.status).toBe(400);
        expect(denied.body.errors[0].message).toMatch(/reference keys.*require their own write adapters/);
        const noActionGrant = await request({ name: 'No action grant', documentId: 1 }, deniedRole);
        expect(noActionGrant.status).toBe(403);
        for (const observer of [write, sourceFind, sourceFindOne, targetFind, targetFindOne])
          expect(observer).not.toHaveBeenCalled();
        expect(await sources.model.findAll({ raw: true, order: [['id', 'ASC']] })).toEqual(before);
        expect(await targets.model.findAll({ raw: true })).toEqual([]);
      } finally {
        for (const observer of [write, sourceFind, sourceFindOne, targetFind, targetFindOne]) observer.mockRestore();
      }
    },
  );
});

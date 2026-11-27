import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import EncryptionFieldPlugin from '../../../../../plugin-field-encryption/src/server';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated encrypted business-field writes', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
  });

  // Bypassing native setters, disclosing a write-only value or re-encrypting an untouched value must fail.
  // 绕过原生加密、泄露只写字段或对未修改的值重复加密，都应导致失败。
  it('preserves encrypted storage for a write-only business field through normal creates and edits', async () => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
    app = await createTenantApp({
      aclFactory: createACL,
      database: { dialect: 'sqlite', storage: ':memory:' },
      extraPlugins: [EncryptionFieldPlugin],
    });
    for (const id of ['B', 'C'])
      await app.db.getRepository('tenants').create({ values: { id, name: id, enabled: true } });
    const roles = ['encrypted-task-editor', 'encrypted-task-name-reader'];
    for (const name of roles)
      await app.db.getRepository('roles').create({ values: { name, strategy: { actions: [] }, snippets: [] } });
    const account = 'encrypted-task-author';
    const password = 'encrypted-task-test-password';
    const user = await app.db.getRepository('users').create({
      values: { username: account, password, roles, tenants: ['B', 'C'], defaultTenantId: 'B' },
    });
    const userId = user.get('id');
    const collectionName = 'encryptedBusinessTasks';
    const stored = await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: collectionName,
        tenancy: 'tenantScoped',
        timestamps: false,
        createdBy: false,
        updatedBy: false,
        fields: [
          { name: 'name', type: 'string' },
          { name: 'note', type: 'encryption', iv: '0123456789abcdef' },
        ],
      },
    });
    const fields = ['id', 'name', 'tenantId'];
    for (const [index, roleName] of roles.entries()) {
      const expected =
        index === 0
          ? [
              { name: 'create', fields: ['name', 'note'] },
              { name: 'list', fields },
              { name: 'update', fields: ['name', 'note'] },
            ]
          : [{ name: 'list', fields: ['id', 'name', 'tenantId'] }];
      const resource = await app.db.getRepository('dataSourcesRolesResources').create({
        values: { dataSourceKey: 'main', roleName, name: collectionName, usingActionsConfig: true, actions: expected },
      });
      const actions = await resource.getActions({});
      expect(
        actions
          .map((action) => ({
            name: action.get('name'),
            fields: [...action.get('fields')].sort(),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ).toEqual(expected.map((action) => ({ ...action, fields: [...action.fields].sort() })));
    }
    const collection = app.db.getCollection(collectionName);
    const rows = () => collection.model.findAll({ raw: true, order: [['id', 'ASC']] });
    expect(await rows()).toEqual([]);
    const identity = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName };
    await app.db.collection(accessConfigHistory).model.sync();
    const registry = new AccessMainRootResourceRegistry(app);
    const config = configFor(ownerCondition);
    await registry.store.save(
      identity,
      {
        ...config,
        revision: 0,
        rules: roles.map((roleName) => ({
          ...config.rules[0],
          id: roleName,
          subject: {
            type: 'all',
            children: [
              {
                type: 'compare',
                operator: 'eq',
                left: { type: 'context', path: 'user.id' },
                right: { type: 'literal', value: String(userId) },
              },
              {
                type: 'compare',
                operator: 'eq',
                left: { type: 'context', path: 'role.name' },
                right: { type: 'literal', value: roleName },
              },
            ],
          },
        })),
      },
      { userId },
    );
    const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
    unregister = adapter.register();
    registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
      registry.select(ctx, adapter, [identity.collectionKey]),
    );
    const signedIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({ account, password });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.data.user).toMatchObject({ id: userId, hasPassword: true });
    const token = signedIn.body.data.token;
    expect(token).toEqual(expect.any(String));
    const agent = (tenant = 'B', role = roles[0]) =>
      app
        .agent()
        .set('Authorization', `Bearer ${token}`)
        .set('X-Authenticator', 'basic')
        .set('X-Role', role)
        .set('X-Tenant-Id', tenant);
    const checked = await agent().get('/auth:check');
    expect(checked.status).toBe(200);
    expect(checked.body.data.id).toBe(userId);
    for (const [index, tenant] of ['B', 'C'].entries()) {
      const created = await agent(tenant)
        .resource(collectionName)
        .create({
          values: { name: `Task ${tenant}`, note: `Harmless note ${tenant}` },
        });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      expect(created.body.data).toEqual({ keys: [index + 1], affected: 1 });
    }
    const initial = await rows();
    expect(initial).toEqual([
      { id: 1, name: 'Task B', note: expect.stringMatching(/^[0-9a-f]{32,}$/), tenantId: 'B' },
      { id: 2, name: 'Task C', note: expect.stringMatching(/^[0-9a-f]{32,}$/), tenantId: 'C' },
    ]);
    expect(initial[0].note).not.toBe(initial[1].note);
    const list = async (tenant: string, name = `Task ${tenant}`) => {
      const response = await agent(tenant)
        .resource(collectionName)
        .list({ fields, sort: ['id'] });
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([{ id: tenant === 'B' ? 1 : 2, name, tenantId: tenant }]);
    };
    expect((await collection.model.findByPk(1)).get('note')).toBe('Harmless note B');
    expect((await collection.model.findByPk(2)).get('note')).toBe('Harmless note C');
    await list('B');
    await list('C');
    const names = await agent('B', roles[1])
      .resource(collectionName)
      .list({ sort: ['id'] });
    expect(names.status).toBe(200);
    expect(names.body.data).toEqual([{ id: 1, name: 'Task B', tenantId: 'B' }]);
    const denied = await agent('B', roles[1])
      .resource(collectionName)
      .update({ filterByTk: 1, values: { note: 'Reader edit' } });
    expect(denied.status).toBe(403);
    expect(await rows()).toEqual(initial);
    const foreign = await agent()
      .resource(collectionName)
      .update({ filterByTk: 2, values: { note: 'Wrong tenant edit' } });
    expect(foreign.status).toBe(403);
    expect(await rows()).toEqual(initial);
    const renamed = await agent()
      .resource(collectionName)
      .update({ filterByTk: 1, values: { name: 'Renamed task B' } });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data).toEqual({ keys: [1], affected: 1 });
    expect(await rows()).toEqual([{ ...initial[0], name: 'Renamed task B' }, initial[1]]);
    await list('B', 'Renamed task B');
    const edited = await agent()
      .resource(collectionName)
      .update({ filterByTk: 1, values: { note: 'Updated harmless note B' } });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.data).toEqual({ keys: [1], affected: 1 });
    const final = await rows();
    expect(final).toEqual([
      { id: 1, name: 'Renamed task B', note: expect.stringMatching(/^[0-9a-f]{32,}$/), tenantId: 'B' },
      initial[1],
    ]);
    expect(final[0].note).not.toBe(initial[0].note);
    expect((await collection.model.findByPk(1)).get('note')).toBe('Updated harmless note B');
    expect((await collection.model.findByPk(2)).get('note')).toBe('Harmless note C');
    await list('B', 'Renamed task B');
    await list('C');
  });
});

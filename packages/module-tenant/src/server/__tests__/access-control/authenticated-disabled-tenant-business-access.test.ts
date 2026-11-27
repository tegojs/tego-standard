import { pathToFileURL } from 'node:url';

import { createTenantApp } from '../utils';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated access after tenant disablement', () => {
  it('re-resolves a signed-in member to an enabled tenant after their default tenant is disabled', async () => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
    const app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });

    try {
      await app.db.getRepository('tenants').create({
        values: [
          { id: 'A', name: 'Tenant A', enabled: true },
          { id: 'B', name: 'Tenant B', enabled: true },
        ],
      });

      const managerRole = 'disable-tenant-manager';
      const memberRole = 'disable-tenant-member';
      const password = 'disable-tenant-business-password';
      await app.db.getRepository('roles').create({
        values: [
          { name: managerRole, strategy: { actions: [] }, snippets: ['pm.tenant.manage'] },
          { name: memberRole, strategy: { actions: [] }, snippets: [] },
        ],
      });
      const manager = await app.db.getRepository('users').create({
        values: { username: managerRole, password, roles: [managerRole] },
      });
      const member = await app.db.getRepository('users').create({
        values: {
          username: memberRole,
          password,
          roles: [memberRole],
          tenants: ['A', 'B'],
          defaultTenantId: 'B',
        },
      });

      const collectionName = 'disabled_tenant_business_records';
      await app.db.getRepository('collections').create({
        context: {},
        values: {
          name: collectionName,
          tenancy: 'tenantScoped',
          timestamps: false,
          createdBy: false,
          updatedBy: false,
          fields: [{ type: 'string', name: 'title' }],
        },
      });
      const collection = app.db.getCollection(collectionName);
      await app.db.getRepository('dataSourcesRolesResources').create({
        values: {
          dataSourceKey: 'main',
          roleName: memberRole,
          name: collectionName,
          usingActionsConfig: true,
          actions: [{ name: 'list', fields: ['id', 'title', 'tenantId'] }],
        },
      });

      const signIn = async (username: string) => {
        const response = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
          account: username,
          password,
        });
        expect(response.status).toBe(200);
        return () =>
          app
            .agent()
            .set('Authorization', `Bearer ${response.body.data.token}`)
            .set('X-Authenticator', 'basic')
            .set('X-Role', username);
      };
      const managerAgent = await signIn(manager.username);
      const memberAgent = await signIn(member.username);

      await collection.model.bulkCreate([
        { id: 1, title: 'A record', tenantId: 'A' },
        { id: 2, title: 'B record', tenantId: 'B' },
      ]);
      const before = await memberAgent()
        .set('X-Tenant-Id', 'B')
        .resource(collectionName)
        .list({ fields: ['id', 'title', 'tenantId'], sort: ['id'] });
      expect(before.status).toBe(200);
      expect(before.body.data).toEqual([{ id: 2, title: 'B record', tenantId: 'B' }]);

      const disabled = await managerAgent()
        .resource('tenants')
        .update({
          filterByTk: 'B',
          values: { enabled: false },
        });
      expect(disabled.status).toBe(200);
      expect((await app.db.getRepository('tenants').findOne({ filterByTk: 'B' })).get('enabled')).toBeFalsy();
      expect(
        (await app.db.getRepository('tenantUsers').find({ filter: { userId: member.get('id') } }))
          .map((membership: any) => String(membership.get('tenantId')))
          .sort(),
      ).toEqual(['A', 'B']);

      const fallback = await memberAgent()
        .resource(collectionName)
        .list({
          fields: ['id', 'title', 'tenantId'],
          sort: ['id'],
        });
      expect(fallback.status).toBe(200);
      expect(fallback.body.data).toEqual([{ id: 1, title: 'A record', tenantId: 'A' }]);

      const disabledTenant = await memberAgent()
        .set('X-Tenant-Id', 'B')
        .resource(collectionName)
        .list({ fields: ['id', 'title', 'tenantId'], sort: ['id'] });
      expect(disabledTenant.status).toBe(403);
      expect(disabledTenant.body).not.toHaveProperty('data');
      expect(await collection.model.findAll({ raw: true, order: [['id', 'ASC']] })).toEqual([
        { id: 1, title: 'A record', tenantId: 'A' },
        { id: 2, title: 'B record', tenantId: 'B' },
      ]);
    } finally {
      await app.destroy();
    }
  });
});

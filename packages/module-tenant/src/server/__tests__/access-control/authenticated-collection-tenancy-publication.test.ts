import { pathToFileURL } from 'node:url';

import { createTenantApp } from '../utils';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated collection tenancy publication', () => {
  it('enforces a manager-published tenancy mode on subsequent business reads and writes', async () => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
    const app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
    try {
      await app.db.getRepository('tenants').create({
        values: [
          { id: 'B', name: 'Tenant B', enabled: true },
          { id: 'C', name: 'Tenant C', enabled: true },
        ],
      });
      const password = 'collection-tenancy-publication-password';
      const managerRole = 'collection-tenancy-manager';
      const memberRole = 'collection-tenancy-member';
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
        values: { username: memberRole, password, roles: [memberRole], tenants: ['B'], defaultTenantId: 'B' },
      });

      const collectionName = 'published_tenant_documents';
      await app.db.getRepository('collections').create({
        values: {
          name: collectionName,
          tenancy: 'shared',
          timestamps: false,
          createdBy: false,
          updatedBy: false,
          fields: [{ type: 'string', name: 'title' }],
        },
        context: {},
      });
      const collection = app.db.getCollection(collectionName);
      await app.db.getRepository('dataSourcesRolesResources').create({
        values: {
          dataSourceKey: 'main',
          roleName: memberRole,
          name: collectionName,
          usingActionsConfig: true,
          actions: [
            { name: 'list', fields: ['id', 'title', 'tenantId'] },
            { name: 'create', fields: ['title'] },
            { name: 'update', fields: ['title'] },
          ],
        },
      });
      const signIn = async (username: string) => {
        const response = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
          account: username,
          password,
        });
        expect(response.status).toBe(200);
        return app
          .agent()
          .set('Authorization', `Bearer ${response.body.data.token}`)
          .set('X-Authenticator', 'basic')
          .set('X-Role', username);
      };
      const managerAgent = await signIn(manager.username);
      const memberAgent = await signIn(member.username);

      const saved = await managerAgent.resource('collections').update({
        filterByTk: collectionName,
        values: { tenancy: 'tenantScoped' },
      });
      expect(saved.status).toBe(200);
      expect(collection.options.tenancy).toBe('tenantScoped');
      expect(Object.hasOwn(collection.model.rawAttributes, 'tenantId')).toBe(true);

      await collection.model.bulkCreate([
        { id: 1, title: 'B document', tenantId: 'B' },
        { id: 2, title: 'C document', tenantId: 'C' },
      ]);
      const business = () => memberAgent.set('X-Tenant-Id', 'B').resource(collectionName);
      const listed = await business().list({ fields: ['id', 'title', 'tenantId'], sort: ['id'] });
      expect(listed.status).toBe(200);
      expect(listed.body.data).toEqual([{ id: 1, title: 'B document', tenantId: 'B' }]);

      const created = await business().create({ values: { title: 'Created through published policy' } });
      expect(created.status).toBe(200);
      expect(await collection.model.findAll({ raw: true, order: [['id', 'ASC']] })).toEqual([
        { id: 1, title: 'B document', tenantId: 'B' },
        { id: 2, title: 'C document', tenantId: 'C' },
        { id: 3, title: 'Created through published policy', tenantId: 'B' },
      ]);

      const crossTenantUpdate = await business().update({ filterByTk: 2, values: { title: 'Cross-tenant edit' } });
      expect((await collection.model.findByPk(2)).get('title')).toBe('C document');
      expect(crossTenantUpdate.status).toBe(200);
      expect(crossTenantUpdate.body.data).toEqual([]);
    } finally {
      await app.destroy();
    }
  });
});

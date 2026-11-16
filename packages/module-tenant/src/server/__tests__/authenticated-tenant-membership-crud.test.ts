import type { MockServer } from '@tachybase/test';

import { createTenantApp } from './utils';

describe('authenticated tenant membership CRUD boundary', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it('does not let an ordinary tenant member change or remove membership directly', async () => {
    app = await createTenantApp();
    await app.db.getRepository('tenants').createMany({
      records: [
        { id: 'B', name: 'B', enabled: true },
        { id: 'C', name: 'C', enabled: true },
      ],
    });

    const role = 'ordinary-tenant-member';
    const password = 'ordinary-tenant-member-password';
    await app.db.getRepository('roles').create({
      values: { name: role, strategy: { actions: [] }, snippets: [] },
    });
    const user = await app.db.getRepository('users').create({
      values: {
        username: 'ordinary-tenant-member',
        email: 'ordinary-tenant-member@example.com',
        phone: '10000000047',
        password,
        roles: [role],
        tenants: ['B'],
        defaultTenantId: 'B',
      },
    });
    const signIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
      account: 'ordinary-tenant-member',
      password,
    });
    expect(signIn.status).toBe(200);
    expect(signIn.body.data.user).toMatchObject({ id: user.id, hasPassword: true });

    const current = () =>
      app
        .agent()
        .set('Authorization', `Bearer ${signIn.body.data.token}`)
        .set('X-Authenticator', 'basic')
        .set('X-Role', role)
        .set('X-Tenant-Id', 'B');
    const readMemberships = async () =>
      (await app.db.getCollection('tenantUsers').model.findAll({ raw: true, order: [['tenantId', 'ASC']] })).map(
        ({ tenantId, userId }) => ({ tenantId, userId }),
      );
    const originalMemberships = await readMemberships();
    expect(originalMemberships).toEqual([{ tenantId: 'B', userId: user.id }]);

    const update = await current()
      .resource('tenantUsers')
      .update({
        filter: { userId: user.id, tenantId: 'B' },
        values: { tenantId: 'C' },
      });
    const destroy = await current()
      .resource('tenantUsers')
      .destroy({
        filter: { userId: user.id, tenantId: 'B' },
      });

    expect(update.status).toBe(403);
    expect(update.body).not.toHaveProperty('data');
    expect(destroy.status).toBe(403);
    expect(destroy.body).not.toHaveProperty('data');
    expect(await readMemberships()).toEqual(originalMemberships);
  });
});

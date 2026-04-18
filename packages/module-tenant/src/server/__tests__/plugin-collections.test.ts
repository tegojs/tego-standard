import type { MockServer } from '@tachybase/test';

import { createTenantApp } from './utils';

describe('tenant plugin collections', () => {
  let app: MockServer;

  afterEach(async () => {
    await app.destroy();
  });

  it('should not define an explicit tenantUsers field on tenants collection', async () => {
    app = await createTenantApp();

    const tenantsCollection = app.db.getCollection('tenants');

    expect(tenantsCollection.getField('tenantUsers')).toBeFalsy();
    expect(tenantsCollection.getField('id')).toBeTruthy();
    expect(app.db.getCollection('users').getField('tenants')).toBeTruthy();
  });
});

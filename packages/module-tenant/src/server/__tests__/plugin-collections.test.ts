import type { MockServer } from '@tachybase/test';

import { NAMESPACE } from '../../constants';
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

  it('should register tenant management acl snippet', async () => {
    app = await createTenantApp();

    const snippet = app.acl.snippetManager.snippets.get('pm.tenant.manage');

    expect(snippet).toBeTruthy();
    expect(snippet.actions).toEqual(
      expect.arrayContaining(['tenants:*', 'tenantUsers:*', 'users:list', 'users:update']),
    );
  });

  it('should register locale resources with tenant namespace', async () => {
    app = await createTenantApp();

    expect(app.i18n.t('Tenant management', { lng: 'zh-CN', ns: NAMESPACE })).toBe('租户管理');
  });
});

import type { MockServer } from '@tachybase/test';

import { getDescendantIds, getDescendantTenants } from '../helpers/tenant-tree';
import { createTenantApp } from './utils';

describe('tenant tree structure', () => {
  let app: MockServer;

  afterEach(async () => {
    await app.destroy();
  });

  it('should generate materialized paths for root, child and multi-level tenants', async () => {
    app = await createTenantApp();

    const rootTenant = await app.db.getRepository('tenants').create({
      values: {
        id: 'root-1',
        name: 'root-1',
        title: 'Root 1',
      },
    });

    const child = await app.db.getRepository('tenants').create({
      values: {
        id: 'child-1',
        name: 'child-1',
        title: 'Child 1',
        parentId: 'root-1',
      },
    });

    const leaf = await app.db.getRepository('tenants').create({
      values: { id: 'leaf', name: 'leaf', title: 'Leaf', parentId: 'child-1' },
    });

    expect(rootTenant.get('path')).toBe('/root-1/');
    expect(rootTenant.get('parentId')).toBeNull();
    expect(child.get('path')).toBe('/root-1/child-1/');
    expect(child.get('parentId')).toBe('root-1');
    expect(leaf.get('path')).toBe('/root-1/child-1/leaf/');
  });

  it('should reject creating a tenant when the materialized path is too long', async () => {
    app = await createTenantApp();

    const longId = `tenant-${'x'.repeat(493)}`;

    await expect(
      app.db.getRepository('tenants').create({
        values: {
          id: longId,
          name: longId,
          title: 'Long Path Tenant',
        },
      }),
    ).rejects.toThrow(/Tenant path exceeds maximum length of 500 characters/);
  });

  it('should find descendant ids and tenant records using path LIKE query', async () => {
    app = await createTenantApp();

    await app.db.getRepository('tenants').create({
      values: [
        { id: 'hq', name: 'hq', title: 'HQ' },
        { id: 'branch-a', name: 'branch-a', title: 'Branch A', parentId: 'hq' },
        { id: 'branch-b', name: 'branch-b', title: 'Branch B', parentId: 'hq' },
        { id: 'dept-x', name: 'dept-x', title: 'Dept X', parentId: 'branch-a' },
        { id: 'other', name: 'other', title: 'Other' },
      ],
    });

    const ids = await getDescendantIds(app.db.getRepository('tenants'), 'hq');
    ids.sort();
    expect(ids).toEqual(['branch-a', 'branch-b', 'dept-x']);
    expect(ids).not.toContain('hq');
    expect(ids).not.toContain('other');

    const tenants = await getDescendantTenants(app.db.getRepository('tenants'), 'hq');
    const tenantIds = tenants.map((tenant: any) => tenant.get('id')).sort();
    const titles = tenants.map((tenant: any) => tenant.get('title'));

    expect(tenantIds).toEqual(['branch-a', 'branch-b', 'dept-x']);
    expect(titles).toContain('Branch A');
    expect(titles).not.toContain('HQ');
    expect(titles).not.toContain('Other');
  });

  it('should exclude disabled descendants from descendant ids', async () => {
    app = await createTenantApp();

    await app.db.getRepository('tenants').create({
      values: [
        { id: 'hq', name: 'hq-disabled-descendant', title: 'HQ' },
        { id: 'enabled-branch', name: 'enabled-branch', title: 'Enabled Branch', parentId: 'hq' },
        { id: 'disabled-branch', name: 'disabled-branch', title: 'Disabled Branch', parentId: 'hq', enabled: false },
      ],
    });

    const ids = await getDescendantIds(app.db.getRepository('tenants'), 'hq');

    expect(ids).toContain('enabled-branch');
    expect(ids).not.toContain('disabled-branch');
  });

  it('should not treat underscore in tenant id as a descendant path wildcard', async () => {
    app = await createTenantApp();

    await app.db.getRepository('tenants').create({
      values: [
        { id: 'root_1', name: 'root_1', title: 'Root underscore' },
        { id: 'root_1_child', name: 'root_1_child', title: 'Child', parentId: 'root_1' },
        { id: 'rootx1', name: 'rootx1', title: 'Root x' },
        { id: 'rootx1_child', name: 'rootx1_child', title: 'Other Child', parentId: 'rootx1' },
      ],
    });

    const ids = await getDescendantIds(app.db.getRepository('tenants'), 'root_1');

    expect(ids).toContain('root_1_child');
    expect(ids).not.toContain('rootx1');
    expect(ids).not.toContain('rootx1_child');
  });

  it('should reject deleting a tenant that has children', async () => {
    app = await createTenantApp();

    await app.db.getRepository('tenants').create({
      values: { id: 'parent', name: 'parent', title: 'Parent' },
    });
    await app.db.getRepository('tenants').create({
      values: { id: 'child', name: 'child', title: 'Child', parentId: 'parent' },
    });

    await expect(
      app.db.getRepository('tenants').destroy({
        filterByTk: 'parent',
      }),
    ).rejects.toThrow(/Cannot delete tenant with children/);
  });

  it('should reject deleting a tenant used as a user default tenant', async () => {
    app = await createTenantApp();

    await app.db.getRepository('tenants').create({
      values: { id: 'default-tenant', name: 'default-tenant', title: 'Default Tenant' },
    });

    await app.db.getRepository('users').create({
      values: {
        username: 'default_tenant_user',
        email: 'default-tenant-user@example.com',
        phone: '3000000001',
        password: '123456',
        defaultTenantId: 'default-tenant',
      },
    });

    await expect(
      app.db.getRepository('tenants').destroy({
        filterByTk: 'default-tenant',
      }),
    ).rejects.toThrow(/default tenant/);
  });

  it('should allow deleting a leaf tenant', async () => {
    app = await createTenantApp();

    await app.db.getRepository('tenants').create({
      values: { id: 'parent', name: 'parent', title: 'Parent' },
    });
    await app.db.getRepository('tenants').create({
      values: { id: 'leaf', name: 'leaf', title: 'Leaf', parentId: 'parent' },
    });

    await app.db.getRepository('tenants').destroy({ filterByTk: 'leaf' });

    const found = await app.db.getRepository('tenants').findOne({ filter: { id: 'leaf' } });
    expect(found).toBeNull();
  });

  it('should reject creating a tenant without a name', async () => {
    app = await createTenantApp();

    await expect(
      app.db.getRepository('tenants').create({
        values: {
          title: 'Missing name tenant',
        },
      }),
    ).rejects.toThrow();
  });

  it('should reject creating a cycle (self-parent)', async () => {
    app = await createTenantApp();

    await app.db.getRepository('tenants').create({
      values: { id: 'a', name: 'a', title: 'A' },
    });

    // The wouldCreateCycle check is in the beforeUpdate hook
    await expect(
      app.db.getRepository('tenants').update({
        filterByTk: 'a',
        values: { parentId: 'a' },
      }),
    ).rejects.toThrow(/cycle/i);
  });

  it('should reject moving a tenant under a disabled parent', async () => {
    app = await createTenantApp();

    await app.db.getRepository('tenants').create({
      values: [
        { id: 'enabled-parent', name: 'enabled-parent', title: 'Enabled Parent' },
        { id: 'disabled-parent', name: 'disabled-parent', title: 'Disabled Parent', enabled: false },
        { id: 'child', name: 'child', title: 'Child', parentId: 'enabled-parent' },
      ],
    });

    await expect(
      app.db.getRepository('tenants').update({
        filterByTk: 'child',
        values: { parentId: 'disabled-parent' },
      }),
    ).rejects.toThrow(/disabled/);
  });

  it('should update child paths when parent path changes (move subtree)', async () => {
    app = await createTenantApp();

    await app.db.getRepository('tenants').create({
      values: [
        { id: 'root-a', name: 'root-a', title: 'Root A' },
        { id: 'root-b', name: 'root-b', title: 'Root B' },
      ],
    });
    await app.db.getRepository('tenants').create({
      values: { id: 'sub', name: 'sub', title: 'Sub', parentId: 'root-a' },
    });
    await app.db.getRepository('tenants').create({
      values: { id: 'deep', name: 'deep', title: 'Deep', parentId: 'sub' },
    });

    // Move 'sub' from root-a to root-b
    await app.db.getRepository('tenants').update({
      filterByTk: 'sub',
      values: { parentId: 'root-b' },
    });

    const sub = await app.db.getRepository('tenants').findOne({ filter: { id: 'sub' } });
    const deep = await app.db.getRepository('tenants').findOne({ filter: { id: 'deep' } });

    expect(sub.get('path')).toBe('/root-b/sub/');
    expect(deep.get('path')).toBe('/root-b/sub/deep/');
  });

  it('should update child paths when moving a subtree to root', async () => {
    app = await createTenantApp();

    await app.db.getRepository('tenants').create({
      values: { id: 'root-a', name: 'root-a', title: 'Root A' },
    });
    await app.db.getRepository('tenants').create({
      values: { id: 'sub', name: 'sub', title: 'Sub', parentId: 'root-a' },
    });
    await app.db.getRepository('tenants').create({
      values: { id: 'deep', name: 'deep', title: 'Deep', parentId: 'sub' },
    });

    await app.db.getRepository('tenants').update({
      filterByTk: 'sub',
      values: { parentId: null },
    });

    const sub = await app.db.getRepository('tenants').findOne({ filter: { id: 'sub' } });
    const deep = await app.db.getRepository('tenants').findOne({ filter: { id: 'deep' } });

    expect(sub.get('parentId')).toBeNull();
    expect(sub.get('path')).toBe('/sub/');
    expect(deep.get('path')).toBe('/sub/deep/');
  });

  describe('create response path correctness', () => {
    it('should return correct path when creating root tenant without explicit id', async () => {
      app = await createTenantApp();

      const tenant = await app.db.getRepository('tenants').create({
        values: {
          name: 'auto-id-root',
          title: 'Auto ID Root',
        },
      });

      const id = tenant.get('id') as string;
      const path = tenant.get('path') as string;

      expect(id).toBeTruthy();
      expect(path).toBeTruthy();
      expect(path).not.toContain('null');
      expect(path).not.toContain('undefined');
      expect(path).toBe(`/${id}/`);
    });

    it('should return correct path when creating child tenant without explicit id', async () => {
      app = await createTenantApp();

      const parent = await app.db.getRepository('tenants').create({
        values: {
          id: 'parent-1',
          name: 'parent-1',
          title: 'Parent 1',
        },
      });

      const child = await app.db.getRepository('tenants').create({
        values: {
          name: 'auto-id-child',
          title: 'Auto ID Child',
          parentId: 'parent-1',
        },
      });

      const childId = child.get('id') as string;
      const childPath = child.get('path') as string;

      expect(childId).toBeTruthy();
      expect(childPath).toBeTruthy();
      expect(childPath).not.toContain('null');
      expect(childPath).not.toContain('undefined');
      expect(childPath).toBe(`/parent-1/${childId}/`);
      expect(parent.get('path')).toBe('/parent-1/');
    });

    it('should return correct path for both parent and child when neither has explicit id', async () => {
      app = await createTenantApp();

      const parent = await app.db.getRepository('tenants').create({
        values: {
          name: 'auto-parent',
          title: 'Auto Parent',
        },
      });

      const parentId = parent.get('id') as string;
      const parentPath = parent.get('path') as string;

      expect(parentId).toBeTruthy();
      expect(parentPath).toBe(`/${parentId}/`);
      expect(parentPath).not.toContain('null');

      const child = await app.db.getRepository('tenants').create({
        values: {
          name: 'auto-child',
          title: 'Auto Child',
          parentId,
        },
      });

      const childId = child.get('id') as string;
      const childPath = child.get('path') as string;

      expect(childId).toBeTruthy();
      expect(childPath).toBe(`/${parentId}/${childId}/`);
      expect(childPath).not.toContain('null');
      expect(childPath).not.toContain('undefined');
    });
  });

  describe('data isolation with tenantInherited mode', () => {
    async function setupInheritedApp() {
      const application = await createTenantApp();

      // Create a tree: hq -> branch-a, branch-b; branch-a -> dept-1
      await application.db.getRepository('tenants').create({
        values: [
          { id: 'hq', name: 'hq', title: 'HQ' },
          { id: 'branch-a', name: 'branch-a', title: 'Branch A', parentId: 'hq' },
          { id: 'branch-b', name: 'branch-b', title: 'Branch B', parentId: 'hq' },
          { id: 'dept-1', name: 'dept-1', title: 'Dept 1', parentId: 'branch-a' },
        ],
      });

      await application.db.getRepository('roles').update({
        filterByTk: 'admin',
        values: {
          strategy: {
            actions: ['create', 'view', 'update', 'destroy'],
          },
        },
      });

      await application.db.getRepository('collections').create({
        values: {
          name: 'inherited_posts',
          tenancy: 'tenantInherited',
          fields: [
            { type: 'string', name: 'title' },
            { type: 'string', name: 'tenantId' },
          ],
        },
        context: {},
      });

      // Seed data: one record per tenant
      for (const tid of ['hq', 'branch-a', 'branch-b', 'dept-1']) {
        await application.db.getRepository('inherited_posts').create({
          values: { title: `Post-${tid}`, tenantId: tid },
        });
      }

      return application;
    }

    it('should enforce inherited visibility and current tenant on create', async () => {
      app = await setupInheritedApp();

      const hqUser = await app.db.getRepository('users').create({
        values: {
          username: 'hq_user',
          email: 'hq@example.com',
          phone: '2000000001',
          password: '123456',
          roles: ['admin'],
          tenants: ['hq'],
          defaultTenantId: 'hq',
        },
      });

      const hqResponse = await app
        .agent()
        .login(hqUser)
        .resource('inherited_posts')
        .list({
          sort: ['title'],
        });

      expect(hqResponse.status).toBe(200);
      const hqTitles = hqResponse.body.data.map((r: any) => r.title);
      // HQ sees all: own + branch-a + branch-b + dept-1
      expect(hqTitles).toEqual(['Post-branch-a', 'Post-branch-b', 'Post-dept-1', 'Post-hq']);

      const branchUser = await app.db.getRepository('users').create({
        values: {
          username: 'branch_user',
          email: 'branch@example.com',
          phone: '2000000002',
          password: '123456',
          roles: ['admin'],
          tenants: ['branch-a'],
          defaultTenantId: 'branch-a',
        },
      });

      const branchResponse = await app
        .agent()
        .login(branchUser)
        .resource('inherited_posts')
        .list({
          sort: ['title'],
        });

      expect(branchResponse.status).toBe(200);
      const branchTitles = branchResponse.body.data.map((r: any) => r.title);
      // branch-a sees: own + dept-1
      expect(branchTitles).toEqual(['Post-branch-a', 'Post-dept-1']);

      const deptUser = await app.db.getRepository('users').create({
        values: {
          username: 'dept_user',
          email: 'dept@example.com',
          phone: '2000000003',
          password: '123456',
          roles: ['admin'],
          tenants: ['dept-1'],
          defaultTenantId: 'dept-1',
        },
      });

      const deptResponse = await app.agent().login(deptUser).resource('inherited_posts').list({});

      expect(deptResponse.status).toBe(200);
      const deptTitles = deptResponse.body.data.map((r: any) => r.title);
      expect(deptTitles).toEqual(['Post-dept-1']);

      const hqCreator = await app.db.getRepository('users').create({
        values: {
          username: 'hq_creator',
          email: 'hq-create@example.com',
          phone: '2000000004',
          password: '123456',
          roles: ['admin'],
          tenants: ['hq'],
          defaultTenantId: 'hq',
        },
      });

      const response = await app
        .agent()
        .login(hqCreator)
        .resource('inherited_posts')
        .create({
          values: { title: 'New Post', tenantId: 'branch-a' },
        });

      expect(response.status).toBe(200);

      const created = await app.db.getRepository('inherited_posts').findOne({
        filter: { title: 'New Post' },
      });
      // Create always uses the current tenant, not the descendant
      expect(created.get('tenantId')).toBe('hq');
    });
  });

  describe('available tenants with tree inheritance', () => {
    it('should include descendants but not ancestors in available list', async () => {
      app = await createTenantApp();

      await app.db.getRepository('tenants').create({
        values: [
          { id: 'hq', name: 'hq', title: 'HQ' },
          { id: 'branch', name: 'branch', title: 'Branch', parentId: 'hq' },
          { id: 'dept', name: 'dept', title: 'Dept', parentId: 'branch' },
        ],
      });

      // User only belongs to 'dept', so ancestors are not part of the switchable tenant scope
      const user = await app.db.getRepository('users').create({
        values: {
          username: 'dept_member',
          email: 'dept-member@example.com',
          phone: '2000000005',
          password: '123456',
          tenants: ['dept'],
          defaultTenantId: 'dept',
        },
      });

      const response = await app.agent().login(user).resource('tenants').available({});

      expect(response.status).toBe(200);
      const ids = response.body.data.map((t: any) => t.id);
      expect(ids).not.toContain('hq');
      expect(ids).not.toContain('branch');
      expect(ids).toContain('dept');

      const hqUser = await app.db.getRepository('users').create({
        values: {
          username: 'hq_member',
          email: 'hq-member@example.com',
          phone: '2000000006',
          password: '123456',
          tenants: ['hq'],
          defaultTenantId: 'hq',
        },
      });

      const hqResponse = await app.agent().login(hqUser).resource('tenants').available({});

      expect(hqResponse.status).toBe(200);
      const hqIds = hqResponse.body.data.map((t: any) => t.id);
      expect(hqIds).toContain('hq');
      expect(hqIds).toContain('branch');
      expect(hqIds).toContain('dept');
    });

    it('should allow switching to descendants and reject switching to ancestors', async () => {
      app = await createTenantApp();

      await app.db.getRepository('tenants').create({
        values: [
          { id: 'hq', name: 'hq', title: 'HQ' },
          { id: 'branch', name: 'branch', title: 'Branch', parentId: 'hq' },
        ],
      });

      const user = await app.db.getRepository('users').create({
        values: {
          username: 'hq_switcher',
          email: 'hq-switcher@example.com',
          phone: '2000000007',
          password: '123456',
          tenants: ['hq'],
          defaultTenantId: 'hq',
        },
      });

      const descendantResponse = await app
        .agent()
        .login(user)
        .resource('tenants')
        .switch({
          values: {
            tenantId: 'branch',
          },
        });

      expect(descendantResponse.status).toBe(200);
      expect(descendantResponse.body.data.id).toBe('branch');

      const branchUser = await app.db.getRepository('users').create({
        values: {
          username: 'branch_switcher',
          email: 'branch-switcher@example.com',
          phone: '2000000008',
          password: '123456',
          tenants: ['branch'],
          defaultTenantId: 'branch',
        },
      });

      const ancestorResponse = await app
        .agent()
        .login(branchUser)
        .resource('tenants')
        .switch({
          values: {
            tenantId: 'hq',
          },
        });

      expect(ancestorResponse.status).toBe(403);
    });
  });
});

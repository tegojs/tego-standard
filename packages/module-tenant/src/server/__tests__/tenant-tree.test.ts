import type { MockServer } from '@tachybase/test';

import { getDescendantIds } from '../helpers/tenant-tree';
import { createTenantApp } from './utils';

describe('tenant tree structure', () => {
  let app: MockServer;

  afterEach(async () => {
    await app.destroy();
  });

  it('should auto-generate path on create with no parent (root tenant)', async () => {
    app = await createTenantApp();

    const tenant = await app.db.getRepository('tenants').create({
      values: {
        id: 'root-1',
        name: 'root-1',
        title: 'Root 1',
      },
    });

    expect(tenant.get('path')).toBe('/root-1/');
    expect(tenant.get('parentId')).toBeNull();
  });

  it('should auto-generate path on create with parent', async () => {
    app = await createTenantApp();

    await app.db.getRepository('tenants').create({
      values: { id: 'parent-1', name: 'parent-1', title: 'Parent 1' },
    });

    const child = await app.db.getRepository('tenants').create({
      values: {
        id: 'child-1',
        name: 'child-1',
        title: 'Child 1',
        parentId: 'parent-1',
      },
    });

    expect(child.get('path')).toBe('/parent-1/child-1/');
    expect(child.get('parentId')).toBe('parent-1');
  });

  it('should build multi-level paths correctly', async () => {
    app = await createTenantApp();

    await app.db.getRepository('tenants').create({
      values: { id: 'root', name: 'root', title: 'Root' },
    });
    await app.db.getRepository('tenants').create({
      values: { id: 'mid', name: 'mid', title: 'Mid', parentId: 'root' },
    });
    const leaf = await app.db.getRepository('tenants').create({
      values: { id: 'leaf', name: 'leaf', title: 'Leaf', parentId: 'mid' },
    });

    expect(leaf.get('path')).toBe('/root/mid/leaf/');
  });

  it('should find descendants using path LIKE query', async () => {
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

    it('should see own + descendant records for tenantInherited collections', async () => {
      app = await setupInheritedApp();

      const user = await app.db.getRepository('users').create({
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

      const response = await app
        .agent()
        .login(user)
        .resource('inherited_posts')
        .list({
          sort: ['title'],
        });

      expect(response.status).toBe(200);
      const titles = response.body.data.map((r: any) => r.title);
      // HQ sees all: own + branch-a + branch-b + dept-1
      expect(titles).toEqual(['Post-branch-a', 'Post-branch-b', 'Post-dept-1', 'Post-hq']);
    });

    it('should only see own + own descendants at branch level', async () => {
      app = await setupInheritedApp();

      const user = await app.db.getRepository('users').create({
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

      const response = await app
        .agent()
        .login(user)
        .resource('inherited_posts')
        .list({
          sort: ['title'],
        });

      expect(response.status).toBe(200);
      const titles = response.body.data.map((r: any) => r.title);
      // branch-a sees: own + dept-1
      expect(titles).toEqual(['Post-branch-a', 'Post-dept-1']);
    });

    it('should only see own records at leaf level', async () => {
      app = await setupInheritedApp();

      const user = await app.db.getRepository('users').create({
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

      const response = await app.agent().login(user).resource('inherited_posts').list({});

      expect(response.status).toBe(200);
      const titles = response.body.data.map((r: any) => r.title);
      expect(titles).toEqual(['Post-dept-1']);
    });

    it('should still force current tenantId on create for inherited collections', async () => {
      app = await setupInheritedApp();

      const user = await app.db.getRepository('users').create({
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
        .login(user)
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
    it('should not include ancestor tenants in available list', async () => {
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
    });

    it('should include descendant tenants in available list', async () => {
      app = await createTenantApp();

      await app.db.getRepository('tenants').create({
        values: [
          { id: 'hq', name: 'hq', title: 'HQ' },
          { id: 'branch', name: 'branch', title: 'Branch', parentId: 'hq' },
          { id: 'dept', name: 'dept', title: 'Dept', parentId: 'branch' },
        ],
      });

      const user = await app.db.getRepository('users').create({
        values: {
          username: 'hq_member',
          email: 'hq-member@example.com',
          phone: '2000000006',
          password: '123456',
          tenants: ['hq'],
          defaultTenantId: 'hq',
        },
      });

      const response = await app.agent().login(user).resource('tenants').available({});

      expect(response.status).toBe(200);
      const ids = response.body.data.map((t: any) => t.id);
      expect(ids).toContain('hq');
      expect(ids).toContain('branch');
      expect(ids).toContain('dept');
    });

    it('should allow switching to descendant tenants', async () => {
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

      const response = await app
        .agent()
        .login(user)
        .resource('tenants')
        .switch({
          values: {
            tenantId: 'branch',
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.data.id).toBe('branch');
    });

    it('should reject switching from descendant tenant to ancestor tenant', async () => {
      app = await createTenantApp();

      await app.db.getRepository('tenants').create({
        values: [
          { id: 'hq', name: 'hq', title: 'HQ' },
          { id: 'branch', name: 'branch', title: 'Branch', parentId: 'hq' },
        ],
      });

      const user = await app.db.getRepository('users').create({
        values: {
          username: 'branch_switcher',
          email: 'branch-switcher@example.com',
          phone: '2000000008',
          password: '123456',
          tenants: ['branch'],
          defaultTenantId: 'branch',
        },
      });

      const response = await app
        .agent()
        .login(user)
        .resource('tenants')
        .switch({
          values: {
            tenantId: 'hq',
          },
        });

      expect(response.status).toBe(403);
    });
  });
});

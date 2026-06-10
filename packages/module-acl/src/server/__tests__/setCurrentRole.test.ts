import { MockServer } from '@tachybase/test';
import Database from '@tego/server';

import { vi } from 'vitest';

import { setCurrentRole } from '../middlewares/setCurrentRole';
import { aclLightTestPlugins, prepareApp } from './prepare';

describe('role', () => {
  let api: MockServer;
  let db: Database;

  let ctx;

  beforeAll(async () => {
    api = await prepareApp({
      plugins: aclLightTestPlugins,
    });

    db = api.db;
  });

  beforeEach(async () => {
    ctx = {
      db,
      cache: api.cache,
      state: {
        currentRole: '',
      },
      t: (key) => key,
    };
  });

  afterAll(async () => {
    await api.destroy();
  });

  const createUser = async (roles = ['root', 'admin', 'member']) => {
    const user = await db.getRepository('users').create({
      values: {
        roles,
      },
    });
    if (roles.includes('root')) {
      await db.getRepository('rolesUsers').update({
        filter: {
          userId: user.get('id'),
          roleName: 'root',
        },
        values: {
          default: true,
        },
      });
    }
    return user;
  };

  it('should set role with X-Role when exists', async () => {
    ctx.state.currentUser = await createUser();
    ctx.state.currentUser = await db.getRepository('users').findOne({
      filterByTk: ctx.state.currentUser.id,
      appends: ['roles'],
    });
    ctx.get = function (name) {
      if (name === 'X-Role') {
        return 'admin';
      }
    };
    await setCurrentRole(ctx, () => {});
    expect(ctx.state.currentRole).toBe('admin');
  });

  it('should set role with default', async () => {
    ctx.state.currentUser = await createUser();
    ctx.state.currentUser = await db.getRepository('users').findOne({
      filterByTk: ctx.state.currentUser.id,
      appends: ['roles'],
    });
    ctx.get = function (name) {
      if (name === 'X-Role') {
        return '';
      }
    };
    await setCurrentRole(ctx, () => {});
    expect(ctx.state.currentRole).toBe('root');
  });

  it('should throw 401', async () => {
    ctx.state.currentUser = await createUser();
    ctx.state.currentUser = await db.getRepository('users').findOne({
      filterByTk: ctx.state.currentUser.id,
      appends: ['roles'],
    });
    ctx.get = function (name) {
      if (name === 'X-Role') {
        return 'abc';
      }
    };
    const throwFn = vi.fn();
    ctx.throw = throwFn;
    await setCurrentRole(ctx, () => {});
    expect(throwFn).lastCalledWith(401, {
      code: 'ROLE_NOT_FOUND_ERR',
      message: 'The user role does not exist. Please try signing in again',
    });
    expect(ctx.state.currentRole).not.toBeDefined();
  });

  it('should set role with anonymous', async () => {
    ctx.state.currentUser = await createUser();
    ctx.state.currentUser = await db.getRepository('users').findOne({
      filterByTk: ctx.state.currentUser.id,
      appends: ['roles'],
    });
    ctx.get = function (name) {
      if (name === 'X-Role') {
        return 'anonymous';
      }
    };
    await setCurrentRole(ctx, () => {});
    expect(ctx.state.currentRole).toBe('anonymous');
  });

  it('should set role in cache', async () => {
    ctx.state.currentUser = await createUser();
    ctx.state.currentUser = await db.getRepository('users').findOne({
      filterByTk: ctx.state.currentUser.id,
      appends: ['roles'],
    });
    ctx.get = function (name) {
      if (name === 'X-Role') {
        return 'admin';
      }
    };
    await setCurrentRole(ctx, () => {});
    const roles = await ctx.cache.get(`roles:${ctx.state.currentUser.id}`);
    expect(roles).toBeDefined();
  });

  it('should update cache when role added', async () => {
    ctx.get = function (name) {
      if (name === 'X-Role') {
        return 'admin';
      }
    };
    await db.getRepository('roles').create({
      values: {
        name: 'set-current-role-added',
        title: 'Test',
      },
    });
    ctx.state.currentUser = await createUser();
    ctx.state.currentUser = await db.getRepository('users').findOne({
      filterByTk: ctx.state.currentUser.id,
      appends: ['roles'],
    });
    await setCurrentRole(ctx, () => {});
    let roles = await ctx.cache.get(`roles:${ctx.state.currentUser.id}`);
    expect(roles).toBeDefined();
    let testRole = roles.find((role) => role.name === 'set-current-role-added');
    expect(testRole).toBeUndefined();

    await db.getRepository('users').update({
      values: {
        roles: [
          ...ctx.state.currentUser.roles,
          {
            name: 'set-current-role-added',
          },
        ],
      },
      filterByTk: ctx.state.currentUser.id,
    });
    roles = await ctx.cache.get(`roles:${ctx.state.currentUser.id}`);
    expect(roles).toBeUndefined();
    await setCurrentRole(ctx, () => {});
    roles = await ctx.cache.get(`roles:${ctx.state.currentUser.id}`);
    expect(roles).toBeDefined();
    testRole = roles.find((role) => role.name === 'set-current-role-added');
    expect(testRole).toBeDefined();
  });

  it('should update cache when one role removed', async () => {
    ctx.get = function (name) {
      if (name === 'X-Role') {
        return 'admin';
      }
    };
    ctx.state.currentUser = await createUser();
    ctx.state.currentUser = await db.getRepository('users').findOne({
      filterByTk: ctx.state.currentUser.id,
      appends: ['roles'],
    });
    await setCurrentRole(ctx, () => {});
    let roles = await ctx.cache.get(`roles:${ctx.state.currentUser.id}`);
    expect(roles).toBeDefined();
    let testRole = roles.find((role) => role.name === 'member');
    expect(testRole).toBeDefined();

    await db.getRepository('users').update({
      values: {
        roles: [
          {
            name: 'root',
          },
          {
            name: 'admin',
          },
        ],
      },
      filterByTk: ctx.state.currentUser.id,
    });
    roles = await ctx.cache.get(`roles:${ctx.state.currentUser.id}`);
    expect(roles).toBeUndefined();
    await setCurrentRole(ctx, () => {});
    roles = await ctx.cache.get(`roles:${ctx.state.currentUser.id}`);
    expect(roles).toBeDefined();
    testRole = roles.find((role) => role.name === 'member');
    expect(testRole).toBeUndefined();
  });

  it('should update cache when all roles removed', async () => {
    ctx.get = function (name) {
      if (name === 'X-Role') {
        return 'admin';
      }
    };
    ctx.state.currentUser = await createUser();
    ctx.state.currentUser = await db.getRepository('users').findOne({
      filterByTk: ctx.state.currentUser.id,
      appends: ['roles'],
    });
    await setCurrentRole(ctx, () => {});
    let roles = await ctx.cache.get(`roles:${ctx.state.currentUser.id}`);
    expect(roles).toBeDefined();

    await db.getRepository('users').update({
      values: {
        roles: null,
      },
      filterByTk: ctx.state.currentUser.id,
    });
    roles = await ctx.cache.get(`roles:${ctx.state.currentUser.id}`);
    expect(roles).toBeUndefined();
    const throwFn = vi.fn();
    ctx.throw = throwFn;
    await setCurrentRole(ctx, () => {});
    expect(throwFn).lastCalledWith(401, {
      code: 'USER_HAS_NO_ROLES_ERR',
      message: 'The current user has no roles. Please try another account.',
    });
    expect(ctx.state.currentRole).not.toBeDefined();
  });

  it('should update cache when role deleted', async () => {
    ctx.get = function (name) {
      if (name === 'X-Role') {
        return 'admin';
      }
    };
    await db.getRepository('roles').create({
      values: {
        name: 'set-current-role-deleted',
        title: 'Deleted role',
      },
    });
    ctx.state.currentUser = await createUser(['admin', 'set-current-role-deleted']);
    ctx.state.currentUser = await db.getRepository('users').findOne({
      filterByTk: ctx.state.currentUser.id,
      appends: ['roles'],
    });
    await setCurrentRole(ctx, () => {});
    let roles = await ctx.cache.get(`roles:${ctx.state.currentUser.id}`);
    expect(roles).toBeDefined();
    let testRole = roles.find((role) => role.name === 'set-current-role-deleted');
    expect(testRole).toBeDefined();

    await db.getRepository('roles').destroy({
      filter: {
        name: 'set-current-role-deleted',
      },
    });
    roles = await ctx.cache.get(`roles:${ctx.state.currentUser.id}`);
    expect(roles).toBeUndefined();
    await setCurrentRole(ctx, () => {});
    roles = await ctx.cache.get(`roles:${ctx.state.currentUser.id}`);
    expect(roles).toBeDefined();
    testRole = roles.find((role) => role.name === 'set-current-role-deleted');
    expect(testRole).toBeUndefined();
  });
});

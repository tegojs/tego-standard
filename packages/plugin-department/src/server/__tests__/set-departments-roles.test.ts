import { vi } from 'vitest';

import { setDepartmentsInfo } from '../middlewares/set-departments-roles';

describe('setDepartmentsInfo', () => {
  const setupContext = () => {
    const findDepartments = vi.fn().mockResolvedValue([{ id: 101, isMain: true }]);
    const findRoles = vi.fn().mockResolvedValue([{ name: 'developer' }]);
    const next = vi.fn();
    const ctx = {
      state: { currentUser: { id: 202 } },
      cache: {
        wrap: vi.fn((_key, loader) => loader()),
      },
      db: {
        getRepository: vi.fn((name) => {
          if (name === 'users.departments') {
            return { find: findDepartments };
          }
          if (name === 'roles') {
            return { find: findRoles };
          }
          throw new Error(`Unexpected repository: ${name}`);
        }),
      },
    } as any;

    return { ctx, findDepartments, findRoles, next };
  };

  it('loads department roles once per request', async () => {
    const { ctx, findDepartments, findRoles, next } = setupContext();

    await setDepartmentsInfo(ctx, next);
    await setDepartmentsInfo(ctx, next);

    expect(findDepartments).toHaveBeenCalledTimes(1);
    expect(findRoles).toHaveBeenCalledTimes(1);
    expect(ctx.state.currentUser.departments).toEqual([{ id: 101, isMain: true }]);
    expect(ctx.state.attachRoles).toEqual([{ name: 'developer' }]);
  });

  it('continues every middleware invocation when department roles are already loaded', async () => {
    const { ctx, next } = setupContext();

    await setDepartmentsInfo(ctx, next);
    await setDepartmentsInfo(ctx, next);

    expect(next).toHaveBeenCalledTimes(2);
  });

  it('preserves roles attached before department roles are loaded', async () => {
    const { ctx, next } = setupContext();
    ctx.state.attachRoles = [{ name: 'pre-attached' }];

    await setDepartmentsInfo(ctx, next);

    expect(ctx.state.attachRoles).toEqual([{ name: 'pre-attached' }, { name: 'developer' }]);
  });
});

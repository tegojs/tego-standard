import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authCheckMiddleware } from '../interceptors';

function createApp(pathname = '/admin/users') {
  return {
    apiClient: {
      axios: {},
      auth: {
        setToken: vi.fn(),
      },
    },
    getHref: (name: string) => `/${name}`,
    router: {
      basename: '',
      navigate: vi.fn(),
      state: {
        location: {
          pathname,
          search: '?tab=profile',
        },
      },
    },
  } as any;
}

describe('authCheckMiddleware', () => {
  let now = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime((now += 4000));
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('clears login state and redirects when an axios 401 auth error only has response.status', async () => {
    const app = createApp();
    const [, errHandler] = authCheckMiddleware({ app });
    const error = {
      response: {
        status: 401,
        data: {
          errors: [
            {
              code: 'TOKEN_RENEW_FAILED',
              message: 'Your session has expired. Please sign in again.',
            },
          ],
        },
      },
      config: {},
    };

    let thrown;
    try {
      errHandler(error);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBe(error);

    expect(app.apiClient.auth.setToken).toHaveBeenCalledWith('');
    expect(app.apiClient.auth.setToken).toHaveBeenCalledWith(null);
    expect(app.router.navigate).toHaveBeenCalledWith('/signin?redirect=/admin/users?tab=profile', { replace: true });
  });

  it('redirects and suppresses repeated notifications when auth check reports an expired session', async () => {
    const app = createApp();
    const [, errHandler] = authCheckMiddleware({ app });
    const error = {
      response: {
        status: 401,
        data: {
          errors: [
            {
              code: 'TOKEN_RENEW_FAILED',
              message: 'Your session has expired. Please sign in again.',
            },
          ],
        },
      },
      config: {
        skipAuth: true,
      },
    };

    let thrown;
    try {
      errHandler(error);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBe(error);

    expect(error.config.skipNotify).toBe(true);
    expect(app.apiClient.auth.setToken).toHaveBeenCalledWith('');
    expect(app.apiClient.auth.setToken).toHaveBeenCalledWith(null);
    expect(app.router.navigate).toHaveBeenCalledWith('/signin?redirect=/admin/users?tab=profile', { replace: true });
  });
});

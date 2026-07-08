import { describe, expect, it, vi } from 'vitest';

import { handleUnauthorizedLocaleLoad } from '../LocalePlugin';

describe('LocalePlugin', () => {
  it('clears auth state and returns the signin redirect URL after locale loading gets a 401', () => {
    window.history.pushState({}, '', '/admin/users?tab=profile');
    const app = {
      getHref: (name: string) => `/${name}`,
      apiClient: {
        auth: {
          setAuthenticator: vi.fn(),
          setRole: vi.fn(),
          setToken: vi.fn(),
        },
      },
    } as any;

    const redirectTo = handleUnauthorizedLocaleLoad(app);

    expect(app.apiClient.auth.setToken).toHaveBeenCalledWith(null);
    expect(app.apiClient.auth.setRole).toHaveBeenCalledWith(null);
    expect(app.apiClient.auth.setAuthenticator).toHaveBeenCalledWith(null);
    expect(redirectTo).toBe('/signin?redirect=/admin/users?tab=profile');
  });
});

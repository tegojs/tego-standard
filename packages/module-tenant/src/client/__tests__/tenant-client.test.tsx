/**
 * Regression: clearing localStorage.current_tenant_id then refreshing must
 * restore the current tenant id from tenants:available response.
 *
 * The provider fetches `tenants:available` once a current user is present.
 * When the server returns a list with one entry marked `current`, the
 * corresponding id must be persisted to storage so that subsequent API
 * requests carry the correct `X-Tenant-Id` header.
 */
import React from 'react';
import { APIClientProvider, Application, mockAPIClient } from '@tachybase/client';
import { act, render, renderHook, waitFor } from '@tachybase/test/client';

import { afterEach, describe, expect, it } from 'vitest';

import PluginTenantClient from '..';
import CurrentTenantProvider, { CurrentTenantContext } from '../CurrentTenantProvider';
import { useSwitchTenant } from '../useSwitchTenant';

const { apiClient, mockRequest } = mockAPIClient();

afterEach(() => {
  mockRequest.reset();
});

const CURRENT_USER_ID = 1;

const fakeCurrentUser = {
  data: {
    data: {
      id: CURRENT_USER_ID,
      username: 'admin',
    },
  },
};

describe('CurrentTenantProvider – localStorage restore', () => {
  it('should persist current_tenant_id to storage when restored from tenants:available', async () => {
    mockRequest.onPost('/tenants:available').reply(() => {
      return [
        200,
        {
          data: [
            { id: 'tenant-a', name: 'Tenant A', current: true },
            { id: 'tenant-b', name: 'Tenant B' },
          ],
        },
      ];
    });

    // Simulate cleared localStorage – no current_tenant_id before refresh.
    apiClient.storage.removeItem('current_tenant_id');
    expect(apiClient.storage.getItem('current_tenant_id')).toBeNull();

    render(
      <APIClientProvider apiClient={apiClient}>
        <CurrentTenantProvider currentUser={fakeCurrentUser}>
          <span>child</span>
        </CurrentTenantProvider>
      </APIClientProvider>,
    );

    // After the API responds, the provider should write the current tenant.
    await waitFor(() => {
      expect(apiClient.storage.getItem('current_tenant_id')).toBe('tenant-a');
    });
  });

  it('should pick first enabled tenant when none is marked current', async () => {
    mockRequest.onPost('/tenants:available').reply(() => {
      return [
        200,
        {
          data: [
            { id: 'tenant-a', name: 'Tenant A', enabled: true },
            { id: 'tenant-b', name: 'Tenant B', enabled: true },
          ],
        },
      ];
    });

    apiClient.storage.removeItem('current_tenant_id');

    render(
      <APIClientProvider apiClient={apiClient}>
        <CurrentTenantProvider currentUser={fakeCurrentUser}>
          <span>child</span>
        </CurrentTenantProvider>
      </APIClientProvider>,
    );

    await waitFor(() => {
      expect(apiClient.storage.getItem('current_tenant_id')).toBe('tenant-a');
    });
  });

  it('should not persist tenant id when tenant module returns empty list', async () => {
    mockRequest.onPost('/tenants:available').reply(() => {
      return [200, { data: [] }];
    });

    apiClient.storage.removeItem('current_tenant_id');

    render(
      <APIClientProvider apiClient={apiClient}>
        <CurrentTenantProvider currentUser={fakeCurrentUser}>
          <span>child</span>
        </CurrentTenantProvider>
      </APIClientProvider>,
    );

    await waitFor(() => {
      expect(apiClient.storage.getItem('current_tenant_id')).toBeNull();
    });
  });

  it('should not call tenants:available when no current user', async () => {
    let requestMade = false;
    mockRequest.onPost('/tenants:available').reply(() => {
      requestMade = true;
      return [200, { data: [] }];
    });

    apiClient.storage.removeItem('current_tenant_id');

    render(
      <APIClientProvider apiClient={apiClient}>
        <CurrentTenantProvider currentUser={{ data: { data: null } }}>
          <span>child</span>
        </CurrentTenantProvider>
      </APIClientProvider>,
    );

    // Give the component time to settle.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(requestMade).toBe(false);
    expect(apiClient.storage.getItem('current_tenant_id')).toBeNull();
  });

  it('should persist current_tenant_id when tenant has no explicit "current" flag but is first enabled tenant', async () => {
    mockRequest.onPost('/tenants:available').reply(() => {
      return [
        200,
        {
          data: [
            { id: 'tenant-a', name: 'Tenant A', enabled: true },
            { id: 'tenant-b', name: 'Tenant B', enabled: false },
          ],
        },
      ];
    });

    apiClient.storage.removeItem('current_tenant_id');

    render(
      <APIClientProvider apiClient={apiClient}>
        <CurrentTenantProvider currentUser={fakeCurrentUser}>
          <span>child</span>
        </CurrentTenantProvider>
      </APIClientProvider>,
    );

    await waitFor(() => {
      expect(apiClient.storage.getItem('current_tenant_id')).toBe('tenant-a');
    });
  });

  it('should restore tenant id when currentUser loads asynchronously (no prop)', async () => {
    mockRequest.onPost('/tenants:available').reply(() => {
      return [
        200,
        {
          data: [
            { id: 'tenant-x', name: 'Tenant X', current: true },
            { id: 'tenant-y', name: 'Tenant Y' },
          ],
        },
      ];
    });

    apiClient.storage.removeItem('current_tenant_id');

    // Render without currentUser prop – relies on useCurrentUserContext().
    const { CurrentUserContext } = await import('@tachybase/client');
    render(
      <APIClientProvider apiClient={apiClient}>
        <CurrentUserContext.Provider value={fakeCurrentUser}>
          <CurrentTenantProvider>
            <span>child</span>
          </CurrentTenantProvider>
        </CurrentUserContext.Provider>
      </APIClientProvider>,
    );

    await waitFor(() => {
      expect(apiClient.storage.getItem('current_tenant_id')).toBe('tenant-x');
    });
  });

  it('should restore tenant id when API responds with delay', async () => {
    mockRequest.onPost('/tenants:available').reply(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return [
        200,
        {
          data: [{ id: 'tenant-delayed', name: 'Delayed Tenant', current: true }],
        },
      ];
    });

    apiClient.storage.removeItem('current_tenant_id');

    render(
      <APIClientProvider apiClient={apiClient}>
        <CurrentTenantProvider currentUser={fakeCurrentUser}>
          <span>child</span>
        </CurrentTenantProvider>
      </APIClientProvider>,
    );

    // Before the API responds, storage should remain empty.
    expect(apiClient.storage.getItem('current_tenant_id')).toBeNull();

    await waitFor(() => {
      expect(apiClient.storage.getItem('current_tenant_id')).toBe('tenant-delayed');
    });
  });

  it('should not clear storage during loading before API responds', async () => {
    // Pre-populate storage to simulate an existing session.
    apiClient.storage.setItem('current_tenant_id', 'existing-tenant');

    let resolveRequest: (value: any) => void;
    const requestPromise = new Promise((resolve) => {
      resolveRequest = resolve;
    });

    mockRequest.onPost('/tenants:available').reply(async () => {
      await requestPromise;
      return [
        200,
        {
          data: [{ id: 'tenant-a', name: 'Tenant A', current: true }],
        },
      ];
    });

    render(
      <APIClientProvider apiClient={apiClient}>
        <CurrentTenantProvider currentUser={fakeCurrentUser}>
          <span>child</span>
        </CurrentTenantProvider>
      </APIClientProvider>,
    );

    // While loading, the existing value should not be cleared.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(apiClient.storage.getItem('current_tenant_id')).toBe('existing-tenant');

    // Complete the request.
    act(() => {
      resolveRequest!(null);
    });

    await waitFor(() => {
      expect(apiClient.storage.getItem('current_tenant_id')).toBe('tenant-a');
    });
  });

  it('should refetch available tenants when active user changes', async () => {
    const requests: any[] = [];
    mockRequest.onPost('/tenants:available').reply((config) => {
      requests.push(config);
      const tenantId = requests.length === 1 ? 'tenant-user-1' : 'tenant-user-2';
      return [200, { data: [{ id: tenantId, current: true }] }];
    });

    apiClient.storage.removeItem('current_tenant_id');

    const { rerender } = render(
      <APIClientProvider apiClient={apiClient}>
        <CurrentTenantProvider currentUser={{ data: { data: { id: 1 } } }}>
          <span>child</span>
        </CurrentTenantProvider>
      </APIClientProvider>,
    );

    await waitFor(() => {
      expect(apiClient.storage.getItem('current_tenant_id')).toBe('tenant-user-1');
    });

    rerender(
      <APIClientProvider apiClient={apiClient}>
        <CurrentTenantProvider currentUser={{ data: { data: { id: 2 } } }}>
          <span>child</span>
        </CurrentTenantProvider>
      </APIClientProvider>,
    );

    await waitFor(() => {
      expect(apiClient.storage.getItem('current_tenant_id')).toBe('tenant-user-2');
    });
    expect(requests).toHaveLength(2);
  });

  it('should not persist tenant id or reload when tenant switch fails', async () => {
    mockRequest.onPost('/tenants:switch').reply(500, { errors: [{ message: 'switch failed' }] });
    apiClient.storage.removeItem('current_tenant_id');

    const wrapper = ({ children }) => (
      <APIClientProvider apiClient={apiClient}>
        <CurrentTenantContext.Provider
          value={{
            data: {
              data: [
                { id: 'tenant-a', title: 'Tenant A', current: true },
                { id: 'tenant-b', title: 'Tenant B' },
              ],
            },
          }}
        >
          {children}
        </CurrentTenantContext.Provider>
      </APIClientProvider>
    );
    const { result } = renderHook(() => useSwitchTenant(), { wrapper });
    const onChange = result.current?.props.children.props.onChange;

    await act(async () => {
      await expect(onChange('tenant-b')).resolves.toBeUndefined();
    });

    expect(apiClient.storage.getItem('current_tenant_id')).toBeNull();
  });
});

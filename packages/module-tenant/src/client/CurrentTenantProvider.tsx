import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useAPIClient, useCurrentUserContext, useRequest } from '@tachybase/client';

import { CURRENT_TENANT_ID_STORAGE_KEY } from './constants';

type AvailableTenantItem = {
  id: string;
  current?: boolean;
  enabled?: boolean;
  name?: string;
  title?: string;
};

type AvailableTenantsResult = {
  data: AvailableTenantItem[];
  userId?: string | number | null;
};

interface CurrentTenantProviderProps {
  children?: React.ReactNode;
  currentUser?: {
    data?: {
      data?: {
        id?: string | number | null;
      } | null;
    };
  };
}

export type AvailableTenantsRequestState = Pick<
  ReturnType<typeof useRequest<AvailableTenantsResult>>,
  'data' | 'loading'
>;

/**
 * Provides the available-tenant request state to tenant-aware navigation components.
 */
export const CurrentTenantContext = createContext<AvailableTenantsRequestState | null | undefined>(null);
CurrentTenantContext.displayName = 'CurrentTenantContext';

/**
 * Reads the current available-tenant request state from React context.
 */
export const useCurrentTenantContext = () => {
  return useContext(CurrentTenantContext);
};

/**
 * Loads available tenants for the active user and keeps local storage aligned with the server state.
 */
export const CurrentTenantProvider = ({ children, currentUser: currentUserProp }: CurrentTenantProviderProps) => {
  const api = useAPIClient();
  const currentUserContext = useCurrentUserContext();
  const currentUser = currentUserProp || currentUserContext;
  const currentUserId = currentUser?.data?.data?.id;
  const [synchronizedTenantKey, setSynchronizedTenantKey] = useState<string | null>(null);
  const result = useRequest<AvailableTenantsResult>(
    () =>
      api
        .resource('tenants')
        .available()
        .then((res) => ({
          ...(res?.data || { data: [] }),
          userId: currentUserId,
        })),
    {
      ready: !!currentUserId,
      refreshDeps: [currentUserId],
    },
  );

  const noUserFallback = useMemo<AvailableTenantsRequestState>(() => ({ data: { data: [] }, loading: false }), []);
  const value = useMemo<AvailableTenantsRequestState>(() => {
    if (!currentUserId) {
      return noUserFallback;
    }

    if (result.loading || result.data === undefined || result.data.userId !== currentUserId) {
      return {
        data: { data: [], userId: currentUserId },
        loading: result.loading,
      };
    }

    return result;
  }, [currentUserId, noUserFallback, result]);

  const tenants = value?.data?.data || [];
  const currentTenant = tenants.find((item) => item.current) || tenants.find((item) => item.enabled !== false);
  const tenantKey = currentUserId ? `${currentUserId}:${currentTenant?.id || ''}` : null;

  useEffect(() => {
    // Guard: only act after the API response has actually arrived.
    // During refreshDeps reloads, useRequest may keep stale data while loading.
    if (currentUserId && value?.loading) {
      return;
    }

    if (currentUserId && value?.data?.userId !== currentUserId) {
      return;
    }

    if (!tenants.length) {
      api.storage?.removeItem?.(CURRENT_TENANT_ID_STORAGE_KEY);
      setSynchronizedTenantKey(tenantKey);
      return;
    }

    if (currentTenant?.id) {
      api.storage?.setItem?.(CURRENT_TENANT_ID_STORAGE_KEY, currentTenant.id);
      setSynchronizedTenantKey(tenantKey);
      return;
    }

    api.storage?.removeItem?.(CURRENT_TENANT_ID_STORAGE_KEY);
    setSynchronizedTenantKey(tenantKey);
  }, [api.storage, currentTenant?.id, currentUserId, tenantKey, tenants, value?.data?.userId, value?.loading]);

  const tenantContextReady =
    !currentUserId || (!value.loading && value.data?.userId === currentUserId && synchronizedTenantKey === tenantKey);

  return (
    <CurrentTenantContext.Provider value={value}>{tenantContextReady ? children : null}</CurrentTenantContext.Provider>
  );
};

export default CurrentTenantProvider;

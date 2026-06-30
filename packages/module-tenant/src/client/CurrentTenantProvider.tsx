import React, { createContext, useContext, useEffect, useMemo } from 'react';
import { useAPIClient, useCurrentUserContext, useRequest } from '@tachybase/client';

type AvailableTenantItem = {
  id: string;
  current?: boolean;
  enabled?: boolean;
  name?: string;
  title?: string;
};

type AvailableTenantsResult = {
  data: AvailableTenantItem[];
};

export const CurrentTenantContext = createContext<any>(null);
CurrentTenantContext.displayName = 'CurrentTenantContext';

export const useCurrentTenantContext = () => {
  return useContext(CurrentTenantContext);
};

export const CurrentTenantProvider = ({ children, currentUser: currentUserProp }) => {
  const api = useAPIClient();
  const currentUserContext = useCurrentUserContext();
  const currentUser = currentUserProp || currentUserContext;
  const currentUserId = currentUser?.data?.data?.id;
  const result = useRequest<AvailableTenantsResult>(
    () =>
      api
        .resource('tenants')
        .available()
        .then((res) => res?.data),
    {
      ready: !!currentUserId,
    },
  );

  const noUserFallback: ReturnType<typeof useRequest<AvailableTenantsResult>> = useMemo(
    () => ({ data: { data: [] }, loading: false }) as any,
    [],
  );
  const value = currentUserId ? result : noUserFallback;

  useEffect(() => {
    // Guard: only act after the API response has actually arrived.
    // During loading, value?.data is undefined – skip to avoid
    // prematurely clearing a previously-persisted tenant id.
    if (currentUserId && value?.data === undefined) {
      return;
    }

    const tenants = value?.data?.data || [];
    if (!tenants.length) {
      api.storage?.removeItem?.('current_tenant_id');
      return;
    }

    const currentTenant = tenants.find((item) => item.current) || tenants.find((item) => item.enabled !== false);
    if (currentTenant?.id) {
      api.storage?.setItem?.('current_tenant_id', currentTenant.id);
    }
  }, [api.storage, currentUserId, value?.data, value?.data?.data]);

  return <CurrentTenantContext.Provider value={value}>{children}</CurrentTenantContext.Provider>;
};

export default CurrentTenantProvider;

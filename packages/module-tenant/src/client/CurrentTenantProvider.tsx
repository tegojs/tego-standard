import React, { createContext, useContext, useEffect } from 'react';

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
  const currentUser = currentUserProp || useCurrentUserContext();
  const currentUserId = currentUser?.data?.data?.id;
  const result = useRequest<AvailableTenantsResult>(() =>
    api
      .resource('tenants')
      .available()
      .then((res) => res?.data),
    {
      ready: !!currentUserId,
    },
  );

  const value = currentUserId ? result : ({ data: { data: [] }, loading: false } as typeof result);

  useEffect(() => {
    const tenants = value?.data?.data || [];
    if (!tenants.length) {
      api.storage?.removeItem?.('current_tenant_id');
      return;
    }

    const currentTenant = tenants.find((item) => item.current) || tenants.find((item) => item.enabled !== false);
    if (currentTenant?.id) {
      api.storage?.setItem?.('current_tenant_id', currentTenant.id);
    }
  }, [api.storage, value?.data?.data]);

  return <CurrentTenantContext.Provider value={value}>{children}</CurrentTenantContext.Provider>;
};

export default CurrentTenantProvider;

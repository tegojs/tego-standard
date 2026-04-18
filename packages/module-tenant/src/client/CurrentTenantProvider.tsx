import React, { createContext, useContext } from 'react';

import { useAPIClient, useCurrentUserContext, useRequest } from '@tachybase/client';

export const CurrentTenantContext = createContext<any>(null);
CurrentTenantContext.displayName = 'CurrentTenantContext';

export const useCurrentTenantContext = () => {
  return useContext(CurrentTenantContext);
};

export const CurrentTenantProvider = ({ children }) => {
  const api = useAPIClient();
  const currentUser = useCurrentUserContext();
  const currentUserId = currentUser?.data?.data?.id;
  const result = useRequest(() =>
    api
      .resource('tenants')
      .available()
      .then((res) => res?.data),
    {
      ready: !!currentUserId,
    },
  );

  const value = currentUserId ? result : { data: { data: [] }, loading: false };

  return <CurrentTenantContext.Provider value={value}>{children}</CurrentTenantContext.Provider>;
};

export default CurrentTenantProvider;

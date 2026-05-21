import React, { useEffect } from 'react';
import { useCurrentNavigationMenu } from '@tachybase/client';

import { useSwitchTenant } from './useSwitchTenant';

export const TenantMenuProvider = ({ children }) => {
  const { addItem } = useCurrentNavigationMenu();
  const switchTenant = useSwitchTenant();

  useEffect(() => {
    if (switchTenant) {
      addItem(switchTenant);
    }
  }, [addItem, switchTenant]);

  return <>{children}</>;
};

export default TenantMenuProvider;

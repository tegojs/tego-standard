import React, { useEffect } from 'react';
import { useCurrentNavigationMenu } from '@tachybase/client';

import { useSwitchTenant } from './useSwitchTenant';

const TENANT_MENU_KEY = 'tenant';

export const TenantMenuProvider = ({ children }: { children?: React.ReactNode }) => {
  const { addItem, removeItem } = useCurrentNavigationMenu();
  const switchTenant = useSwitchTenant();

  useEffect(() => {
    if (switchTenant) {
      addItem(switchTenant);
      return () => removeItem(TENANT_MENU_KEY);
    }
    removeItem(TENANT_MENU_KEY);
  }, [addItem, removeItem, switchTenant]);

  return <>{children}</>;
};

export default TenantMenuProvider;

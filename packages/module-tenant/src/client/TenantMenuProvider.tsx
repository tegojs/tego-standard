import React, { useEffect, useRef } from 'react';
import { useCurrentNavigationMenu } from '@tachybase/client';

import { TENANT_MENU_KEY } from './constants';
import { useSwitchTenant } from './useSwitchTenant';

/**
 * Renders or configures the tenant menu provider client entry point.
 */
export const TenantMenuProvider = ({ children }: { children?: React.ReactNode }) => {
  const { addItem, removeItem } = useCurrentNavigationMenu();
  const switchTenant = useSwitchTenant();
  const latestSwitchTenant = useRef(switchTenant);

  latestSwitchTenant.current = switchTenant;

  useEffect(() => {
    if (switchTenant) {
      addItem(switchTenant);
      return () => {
        if (latestSwitchTenant.current === switchTenant) {
          removeItem(TENANT_MENU_KEY);
        }
      };
    }
    removeItem(TENANT_MENU_KEY);
  }, [addItem, removeItem, switchTenant]);

  return <>{children}</>;
};

export default TenantMenuProvider;

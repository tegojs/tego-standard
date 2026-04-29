import React, { useEffect } from 'react';

import { useCurrentUserSettingsMenu } from '@tachybase/client';

import { useSwitchTenant } from './useSwitchTenant';

export const TenantMenuProvider = ({ children }) => {
  const { addMenuItem } = useCurrentUserSettingsMenu();
  const switchTenant = useSwitchTenant();

  useEffect(() => {
    if (switchTenant) {
      addMenuItem(switchTenant, { before: 'divider_3' });
    }
  }, [addMenuItem, switchTenant]);

  return <>{children}</>;
};

export default TenantMenuProvider;

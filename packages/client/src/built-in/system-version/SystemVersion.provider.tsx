import React, { useEffect } from 'react';

import { useTranslation } from 'react-i18next';

import { useCurrentAppInfo } from '../../common/appInfo/CurrentAppInfoProvider';
import { useCurrentUserSettingsMenu } from '../../user/CurrentUserSettingsMenuProvider';

const CoreVersion = () => {
  const info = useCurrentAppInfo();
  const { t } = useTranslation();
  return (
    <span>
      {t('Core Version')} - {info?.data?.version.core}
    </span>
  );
};

const AppVersion = () => {
  const info = useCurrentAppInfo();
  const { t } = useTranslation();
  return (
    <span>
      {t('App Version')} - {info?.data?.version.app}
    </span>
  );
};

export const SystemVersionProvider = ({ children }) => {
  const { addMenuItem } = useCurrentUserSettingsMenu();

  useEffect(() => {
    addMenuItem(
      {
        key: 'system-version-app',
        label: <AppVersion />,
      },
      { before: 'divider_1' },
    );
    addMenuItem(
      {
        key: 'system-version-core',
        label: <CoreVersion />,
      },
      { before: 'divider_1' },
    );
  }, [addMenuItem]);

  return <>{children}</>;
};

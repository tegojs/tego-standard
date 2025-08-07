import React, { Dispatch, SetStateAction, useState } from 'react';

import { useLocalStorageState } from 'ahooks';
import { useTranslation } from 'react-i18next';

import { Plugin } from '../../application/Plugin';
import { DynamicPage } from './DynamicPage';

declare module '../../application' {
  interface Application {
    usePageMode: typeof useContextPageMode;
  }
}

export class PluginDynamicPage extends Plugin {
  async beforeLoad() {
    this.app.use(PageModeProvider);
  }
  async load() {
    this.app.router.remove('app.page');
    this.app.router.add('app.page', {
      path: '/:entry/:name/*',
      Component: DynamicPage,
    });
    this.app.usePageMode = useContextPageMode;
  }

  async afterLoad() {
    this.app.pluginContextMenu.add(pageMode.name, pageMode);
  }
}

interface PageModeContextType {
  enable: boolean;
  setEnable: Dispatch<SetStateAction<boolean>>;
}

export const PageModeContext = React.createContext<PageModeContextType>({
  enable: false,
  setEnable: () => {},
});

export const PageModeProvider = ({ children }) => {
  const [enable, setEnable] = useLocalStorageState('tb-page-mode', {
    defaultValue: false,
  });
  return <PageModeContext.Provider value={{ enable, setEnable }}>{children}</PageModeContext.Provider>;
};

export const useContextPageMode = () => React.useContext(PageModeContext);

const pageMode = {
  name: 'pageMode',
  useLoadMethod: () => {
    const { enable, setEnable } = useContextPageMode();
    const { t } = useTranslation();
    return {
      title: t('Page mode: {{enabled}}', { enabled: enable ? 'On' : 'Off' }),
      actionProps: {
        onClick: () => {
          setEnable(!enable);
        },
      },
    };
  },
};

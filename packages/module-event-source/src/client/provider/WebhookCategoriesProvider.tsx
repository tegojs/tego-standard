import { createContext, useContext } from 'react';

export const WebhookCategoryContext = createContext<{
  refresh: () => void;
  activeKey: string;
  setActiveKey: (key: string) => void;
}>({
  refresh: () => {},
  activeKey: '',
  setActiveKey: () => {},
});

export const useWebhookCategoryContext = () => {
  return useContext(WebhookCategoryContext);
};

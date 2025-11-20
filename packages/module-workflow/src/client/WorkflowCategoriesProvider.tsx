import { createContext, useContext } from 'react';

export const WorkflowCategoryContext = createContext<{
  data: any[];
  refresh: () => void;
  activeKey: string;
  setActiveKey: (key: string) => void;
  categoriesLoaded?: boolean;
}>({
  data: [],
  refresh: () => {},
  activeKey: '',
  setActiveKey: () => {},
  categoriesLoaded: false,
});

export const useWorkflowCategory = () => useContext(WorkflowCategoryContext);

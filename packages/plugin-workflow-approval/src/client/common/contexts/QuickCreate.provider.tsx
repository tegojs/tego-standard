import React, { useContext, useState } from 'react';

interface ResubmitProps {
  isQuickCreate?: boolean;
  setQuickCreate?: any;
}

export const QuickCreateContext = React.createContext<ResubmitProps>({});

export const QuickCreateProvider = ({ children }) => {
  const [isQuickCreate, setQuickCreate] = useState(false);
  return (
    <QuickCreateContext.Provider value={{ isQuickCreate, setQuickCreate }}>{children}</QuickCreateContext.Provider>
  );
};

export const useQuickCreate = () => {
  return useContext(QuickCreateContext);
};

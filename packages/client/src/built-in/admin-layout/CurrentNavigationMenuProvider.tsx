import React, { createContext, ReactElement, useCallback, useContext, useRef, useState } from 'react';
import { error } from '@tego/client';

type NavigationItem = ReactElement & { key?: React.Key };

const CurrentNavigationMenuContext = createContext<{
  items: React.MutableRefObject<NavigationItem[]>;
  update: () => void;
}>(null);
CurrentNavigationMenuContext.displayName = 'CurrentNavigationMenuContext';

export const useCurrentNavigationMenu = () => {
  const { items, update } = useContext(CurrentNavigationMenuContext) || {};

  const getItems = useCallback(() => {
    return items.current;
  }, [items]);

  const addItem = useCallback(
    (item: NavigationItem) => {
      const index = items.current.findIndex((current) => current.key === item.key);
      if (index !== -1) {
        items.current[index] = item;
      } else {
        items.current.push(item);
      }
      update();
    },
    [items, update],
  );

  if (!items) {
    error('AdminLayout: You should use `CurrentNavigationMenuProvider` in the root of your app.');
    throw new Error('AdminLayout: You should use `CurrentNavigationMenuProvider` in the root of your app.');
  }

  return { getItems, addItem };
};

export const CurrentNavigationMenuProvider = ({ children }) => {
  const items = useRef<NavigationItem[]>([]);
  const [, setVersion] = useState(0);
  const update = useCallback(() => setVersion((version) => version + 1), []);

  return (
    <CurrentNavigationMenuContext.Provider value={{ items, update }}>{children}</CurrentNavigationMenuContext.Provider>
  );
};

import React, { createContext, ReactElement, useCallback, useContext, useRef, useState } from 'react';
import { error } from '@tego/client';

type NavigationItem = ReactElement & { key?: React.Key };

const CurrentNavigationMenuContext = createContext<{
  items: React.MutableRefObject<NavigationItem[]>;
  update: () => void;
}>(null);
CurrentNavigationMenuContext.displayName = 'CurrentNavigationMenuContext';

/**
 * Returns the use current navigation menu hook state.
 */
export const useCurrentNavigationMenu = () => {
  const { items, update } = useContext(CurrentNavigationMenuContext) || {};

  const getItems = useCallback(() => {
    return items.current;
  }, [items]);

  const addItem = useCallback(
    (item: NavigationItem) => {
      if (item.key === null || item.key === undefined) {
        items.current.push(item);
        update();
        return;
      }

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

  const removeItem = useCallback(
    (key: React.Key) => {
      if (key === null || key === undefined) {
        return;
      }

      const nextItems = items.current.filter((current) => current.key !== key);
      if (nextItems.length === items.current.length) {
        return;
      }
      items.current = nextItems;
      update();
    },
    [items, update],
  );

  if (!items) {
    error('AdminLayout: You should use `CurrentNavigationMenuProvider` in the root of your app.');
    throw new Error('AdminLayout: You should use `CurrentNavigationMenuProvider` in the root of your app.');
  }

  return { getItems, addItem, removeItem };
};

/**
 * Renders or configures the current navigation menu provider client entry point.
 */
export const CurrentNavigationMenuProvider = ({ children }) => {
  const items = useRef<NavigationItem[]>([]);
  const [, setVersion] = useState(0);
  const update = useCallback(() => setVersion((version) => version + 1), []);

  return (
    <CurrentNavigationMenuContext.Provider value={{ items, update }}>{children}</CurrentNavigationMenuContext.Provider>
  );
};

import { useContext, useMemo } from 'react';

import { PageStyleContext } from './PageStyle.provider';

// 使用 sessionStorage 缓存 tabItems
export const usePageTabItems = (): { tabItems: any[] } => {
  const context = useContext(PageStyleContext);

  const { items = [], setItems = () => {} } = useMemo(
    () => ({
      items: context?.items || [],
      setItems: context?.setItems || (() => {}),
    }),
    [context],
  );

  return useMemo(() => {
    // 如果 context 中有多个 items，优先使用并缓存
    if (items.length > 1) {
      setCachedItems(items);
      return { tabItems: items };
    }

    // 否则尝试从缓存中获取
    const cachedItems = getCachedItems();
    if (cachedItems.length > 1) {
      setItems(cachedItems);
      return { tabItems: cachedItems };
    }

    // 最后使用 context 中的 items
    return { tabItems: items };
  }, [items, setItems]);
};

const PAGE_TAB_ITEMS_KEY = 'pageTabItems';

const getCachedItems = (): any[] => {
  try {
    const cache = sessionStorage.getItem(PAGE_TAB_ITEMS_KEY);
    if (!cache) return [];

    const cacheItems = JSON.parse(cache);
    return Array.isArray(cacheItems) && cacheItems.length > 1 ? cacheItems : [];
  } catch {
    return [];
  }
};

const setCachedItems = (items: any[]): void => {
  if (!items?.length) return;

  try {
    sessionStorage.setItem(PAGE_TAB_ITEMS_KEY, JSON.stringify(items));
  } catch {
    // 忽略 sessionStorage 错误
  }
};

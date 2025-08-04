import { useContext, useMemo } from 'react';

import { PageStyleContext } from './PageStyle.provider';

const PAGE_TAB_ITEMS_KEY = 'pageTabItems';

// 提取可序列化的 tab 信息（不包含 children）
const extractSerializableData = (items: any[]) => {
  return items.map((item) => ({
    key: item.key,
    label: item.label,
    schemaKey: item.schemaKey,
    disabled: item.disabled,
    closable: item.closable,
    // 注意：不包含 children，因为 React 组件无法序列化
  }));
};

// 从缓存数据重建 tab items（不包含 children）
const rebuildTabItems = (cachedData: any[], originalItems: any[]) => {
  if (!cachedData.length || !originalItems.length) return originalItems;

  // 创建 key 到原始 item 的映射
  const originalItemsMap = new Map(originalItems.map((item) => [item.key, item]));

  // 使用缓存数据的顺序，但保留原始 items 的基本信息（不包含 children）
  return cachedData
    .map((cachedItem) => {
      const originalItem = originalItemsMap.get(cachedItem.key);
      if (originalItem) {
        // 保留原始 item 的基本信息，但不包含 children
        return {
          ...originalItem,
          children: undefined, // 确保 children 为空，触发 RemoteSchemaComponent 重新加载
        };
      }
      return cachedItem;
    })
    .filter(Boolean);
};

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
    // 只缓存可序列化的数据
    const serializableData = extractSerializableData(items);
    sessionStorage.setItem(PAGE_TAB_ITEMS_KEY, JSON.stringify(serializableData));
  } catch {
    // 忽略 sessionStorage 错误
  }
};

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
    const cachedData = getCachedItems();
    if (cachedData.length > 1) {
      // 使用缓存数据重建 tab items（不包含 children）
      const rebuiltItems = rebuildTabItems(cachedData, items);
      setItems(rebuiltItems);
      return { tabItems: rebuiltItems };
    }

    // 最后使用 context 中的 items
    return { tabItems: items };
  }, [items, setItems]);
};

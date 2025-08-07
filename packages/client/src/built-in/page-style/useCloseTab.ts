import { useCallback, useContext } from 'react';

import { useNavigate } from 'react-router';
import { useLocation } from 'react-router-dom';

import { useIsSubPage } from '../../application/CustomRouterContextProvider';
import { PageStyleContext } from './PageStyle.provider';

export const useCloseTab = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { items, setItems } = useContext(PageStyleContext);
  const targetKey = location.pathname;

  const isSubPage = useIsSubPage();

  // 处理关闭标签页后的逻辑，包括跳转、兜底等
  const handleCloseTab = useCallback(
    (e, item) => {
      e?.stopPropagation();
      setItems((items) => {
        const idx = items.findIndex((i) => i.key === item.key);
        const isCurrent = item.key === targetKey;
        const newItems = items.filter((i) => i.key !== item.key);

        if (isCurrent) {
          // 关闭的是当前标签页
          if (newItems.length === 0) {
            // 没有标签页了，跳转到首页
            navigate('/');
          } else {
            // 如果当前页面是子页面,优先返回上一页
            if (isSubPage && window?.history.length > 1) {
              navigate(-1);
            } else {
              // 优先跳转到右侧标签页，否则跳转到左侧
              const nextTab = items[idx + 1] || items[idx - 1];
              if (nextTab) {
                navigate(nextTab.key);
              } else {
                // 理论上不会走到这里，但兜底跳转首页
                navigate('/');
              }
            }
          }
        }
        return newItems;
      });
    },
    [items, targetKey, navigate, setItems],
  );

  return { handleCloseTab };
};

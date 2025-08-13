import { useCallback, useContext } from 'react';

import { useNavigate } from 'react-router';
import { useLocation } from 'react-router-dom';

import { useIsSubPage } from '../../application/CustomRouterContextProvider';
import { PageStyleContext } from './PageStyle.provider';

export const useCloseTab = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { items, setItems } = useContext(PageStyleContext);
  const currentPath = location.pathname;

  const isSubPage = useIsSubPage();

  // 处理关闭标签页后的逻辑，包括跳转、兜底等
  const handleCloseTab = useCallback(
    (e, item) => {
      e?.stopPropagation();
      setItems((items) => {
        const idx = items.findIndex((i) => i.key === item.key);
        const isCurrent = item.key === currentPath;
        const newItems = items.filter((i) => i.key !== item.key);

        if (isCurrent) {
          // 关闭的是当前标签页
          if (newItems.length === 0) {
            // 没有标签页了，跳转到首页
            navigate('/');
          } else {
            // 如果当前页面是子页面,跳转到对应的主页面,主页面是去除 sub 后的路径
            if (isSubPage) {
              const mainPagePath = stripSubPath(currentPath);
              if (mainPagePath && mainPagePath !== currentPath) {
                navigate(mainPagePath);
              } else {
                // 如果无法正确解析主页面路径，则返回上一页兜底, 大部分情况下,主页面和上一页是同一个页面
                navigate(-1);
              }
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
    [items, currentPath, navigate, setItems],
  );

  return { handleCloseTab };
};

/**
 * 从路径中移除 '/sub' 及其后面的所有内容
 * @param {string} path 原始路径
 * @returns {string} 移除后的路径
 */
function stripSubPath(path: string) {
  const subIndex = path.indexOf('/sub');
  return subIndex === -1 ? path : path.slice(0, subIndex);
}

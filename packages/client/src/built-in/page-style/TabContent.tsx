import React, { useContext, useEffect, useMemo } from 'react';

import { Outlet, useLocation, useOutlet, useParams } from 'react-router-dom';

import { useTranslation } from '../..';
import { RemoteSchemaComponent } from '../../schema-component';
import { useDocumentTitle } from '../document-title';
import { PageStyle, PageStyleContext } from './PageStyle.provider';
import { usePageStyle } from './usePageStyle';

interface TabItem {
  key: string;
  label: string | React.ReactNode;
  schemaKey?: string;
  children?: React.ReactNode;
  disabled?: boolean;
  closable?: boolean;
  isCached?: boolean;
}

interface TabContentItemProps {
  item: TabItem;
  activeKey: string;
}

const TabContentItem = ({ item, activeKey }: TabContentItemProps) => {
  const { key, schemaKey, children, label, isCached } = item;
  // 只在激活时渲染内容，非激活时保持内容但隐藏
  return (
    <div
      key={key}
      style={{
        display: activeKey === key ? '' : 'none',
        width: '100%',
        height: '100%',
      }}
    >
      {isCached ? (
        // 如果是从缓存恢复，此时没有 children,使用 RemoteSchemaComponent 根据 schemaKey 重新渲染
        <RemoteSchemaComponent uid={schemaKey} noForm onlyRenderProperties />
      ) : (
        // 如果有 children，直接渲染
        children
      )}
    </div>
  );
};

interface TabContentInternalProps {
  items: TabItem[];
  activeKey: string;
}

const TabContentInternal = ({ items, activeKey }: TabContentInternalProps) => {
  return items.map((item) => <TabContentItem key={item.key} item={item} activeKey={activeKey} />);
};

export const TabContent = () => {
  const { t } = useTranslation();
  const { title, setTitle } = useDocumentTitle();
  const location = useLocation();
  const { items, setItems } = useContext(PageStyleContext);
  const targetKey = location.pathname;

  const schemaKey = useMemo(() => {
    return targetKey.split('/').at(-1) || '';
  }, [targetKey]);

  const outlet = useOutlet();

  useEffect(() => {
    if (targetKey) {
      const targetItem = items.find((value) => value.key === targetKey);
      if (!targetItem) {
        // 现有tab页数组里,不存在之前浏览的tab页面,添加新的tab页进数组
        const targetItem = {
          key: targetKey,
          schemaKey,
          label: title || `${t('tabs')}`,
          children: outlet,
        };
        const newItems = [...items, targetItem];
        setItems(newItems);
      } else {
        // 如果存在之前浏览的tab页面,只用更新页面标题
        setTitle(targetItem?.label);
      }
    }
  }, [targetKey, title]);

  return <TabContentInternal items={items} activeKey={targetKey} />;
};

export const CustomAdminContent = () => {
  const params = useParams<any>();
  const pageStyle = usePageStyle();
  return params.name && pageStyle === PageStyle.TAB_STYLE ? <TabContent /> : <Outlet />;
};

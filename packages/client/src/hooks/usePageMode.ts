import { useCallback, useMemo, useState } from 'react';
import { useFieldSchema } from '@tachybase/schema';

import { useNavigate } from 'react-router-dom';

import { useApp, useCollection, useCollectionRecordData, useIsMobile } from '..';
import { useIsSystemPage } from '../application/CustomRouterContextProvider';
import { PathHandler } from '../built-in/dynamic-page/utils';
import { PageStyle } from '../built-in/page-style/PageStyle.provider';
import { usePageStyle } from '../built-in/page-style/usePageStyle';
import { OpenMode } from '../schema-component/antd/action/context';

// 管理页面模式，包括打开抽屉、弹窗、页面等,
// 在多标签页状态默认打开，在手机状态默认打开，在系统页面默认关闭
export const usePageMode = () => {
  const app = useApp();
  const pageMode = app.usePageMode();
  const pageStyle = usePageStyle();
  const isPageTabStyle = pageStyle === PageStyle.TAB_STYLE;

  const collection = useCollection();
  const record = useCollectionRecordData();
  const collectionKey = collection?.getPrimaryKey();
  const fieldSchema = useFieldSchema();
  const openMode = fieldSchema?.['x-component-props']?.['openMode'];
  const containerSchema = useMemo(
    () => fieldSchema.reduceProperties((buf, s) => (s['x-component'] === 'Action.Container' ? s : buf)),
    [fieldSchema],
  );

  const isMobile = useIsMobile();
  const isSystemPage = useIsSystemPage();

  const navigate = useNavigate();

  const [visible, setVisible] = useState(false);

  // NOTE:page mode 在多标签页状态默认打开，在手机状态默认打开，
  const isPageMode = useMemo(() => {
    switch (openMode) {
      // 明确指定为 PAGE 模式
      case OpenMode.PAGE:
        return true;
      // 明确指定为 MODAL 模式和 DRAWER_MODE 模式
      case OpenMode.MODAL:
      case OpenMode.DRAWER_MODE:
      case OpenMode.SHEET:
        return false;
      // 默认情况,默认模式和 Drawer(兼容旧版,作为默认模式) 模式下, 移动端或多标签页模式下默认为 PAGE 模式
      case OpenMode.DEFAULT:
      case OpenMode.DRAWER:
      default: {
        if (isMobile || isPageTabStyle) {
          return true;
        }
        if (isSystemPage) {
          return false;
        }
        return pageMode?.enable;
      }
    }
  }, [pageMode?.enable, openMode, isMobile, pageStyle, isSystemPage]);

  const openModal = useCallback(() => {
    setVisible(true);
  }, []);

  const openPage = useCallback(() => {
    // 如果 containerSchema 没有 x-uid, 不进行跳转
    if (!containerSchema?.['x-uid']) {
      return;
    }

    const subPath = `sub/${containerSchema?.['x-uid']}`;

    const target = PathHandler.getInstance().toWildcardPath({
      collection: collection?.name,
      filterByTk: record?.[collectionKey],
    });

    const findMPageSchema = (schema) => {
      if (!schema) return;
      if (schema['x-component'] === 'MPage') {
        return schema['x-uid'];
      }
      return findMPageSchema(schema?.parent);
    };
    const MPageUID = findMPageSchema(fieldSchema);

    const pathArray = ['.', isMobile ? MPageUID : '', subPath, target];
    const finalPath = pathArray.filter(Boolean).join('/');

    navigate(finalPath);
  }, [fieldSchema, record, collectionKey, collection?.name, navigate]);

  return {
    isPageMode,
    visible,
    setVisible,
    openModal,
    openPage,
  };
};

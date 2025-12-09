import { useEffect } from 'react';
import {
  useActionContext,
  useCollectionRecordData,
  useDataBlockRequest,
  useDataBlockResource,
  useFilterByTk,
} from '@tachybase/client';
import { useForm } from '@tachybase/schema';

import { message } from 'antd';
import { useTranslation } from 'react-i18next';

/**
 * 工作流复制的 useAction hook
 * 支持设置分类字段的默认值，并在提交时转换为 ID 数组格式
 */
export function useRevisionAction() {
  const { t } = useTranslation();
  const { refresh } = useDataBlockRequest();
  const resource = useDataBlockResource();
  const { setVisible, visible } = useActionContext();
  const filterByTk = useFilterByTk();
  const { values, setInitialValues } = useForm();
  const record = useCollectionRecordData();

  // 当 Modal 打开时，设置分类的默认值为当前工作流的分类
  useEffect(() => {
    if (visible && record?.category) {
      // 直接使用对象数组，这样 CollectionField 可以正确显示分类名称
      // 提交时会自动转换为 ID 数组
      setInitialValues({
        category: record.category,
      });
    }
  }, [visible, record, setInitialValues]);

  return {
    async run() {
      // 确保提交时分类字段是 ID 数组格式
      const submitValues = { ...values };
      if (submitValues.category && Array.isArray(submitValues.category)) {
        submitValues.category = submitValues.category.map((item) =>
          typeof item === 'object' && item?.id != null ? item.id : item,
        );
      }
      await resource.revision({ filterByTk, values: submitValues });
      message.success(t('Operation succeeded'));
      refresh();
      setVisible(false);
    },
  };
}

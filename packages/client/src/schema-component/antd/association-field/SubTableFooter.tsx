import React, { memo, useCallback } from 'react';

import { Button } from 'antd';
import { useTranslation } from 'react-i18next';

import { markRecordAsNew } from '../../../data-source/collection-record/isNewRecord';

interface Props {
  field: any;
  styles: any;
  allowAdd: boolean;
  allowSelect: boolean;
  onSelect: () => void;
  updateFieldValue: (next: any[]) => void;
  dataAccessor?: (updater: (arr: any[]) => any[]) => void; // 新增：用于在外层正确写入数组
}
export const SubTableFooter = memo(
  ({ field, styles, allowAdd, allowSelect, onSelect, updateFieldValue, dataAccessor }: Props) => {
    const { t } = useTranslation();
    if (!field?.editable) return null;

    const commitValue = useCallback(
      (next: any[]) => {
        updateFieldValue(next);
        if (typeof field?.onInput === 'function') field.onInput(next);
        else if (typeof field?.setValue === 'function') field.setValue(next);
        else if (typeof field?.onChange === 'function') field.onChange(next);
        else field && (field.value = next);
      },
      [field, updateFieldValue],
    );

    const onAdd = useCallback(() => {
      const createArr = (prev: any[]) => {
        const base = Array.isArray(prev) ? prev.slice() : [];
        base.push(markRecordAsNew({}));
        return base;
      };
      if (dataAccessor) {
        let nextLocal: any[] = [];
        dataAccessor((prev) => {
          nextLocal = createArr(prev);
          return nextLocal;
        });
        commitValue(nextLocal);
      } else {
        // 退化处理：直接操作 field.value 假设其为数组
        const prev = Array.isArray(field.value) ? field.value : [];
        const next = createArr(prev);
        field.value = next;
        commitValue(next);
      }
    }, [dataAccessor, commitValue, field]);

    return (
      <>
        {allowAdd && (
          <Button type="text" block className={styles.addNew} onClick={onAdd}>
            {t('Add new')}
          </Button>
        )}
        {allowSelect && (
          <Button type="text" block className={styles.select} onClick={onSelect}>
            {t('Select')}
          </Button>
        )}
      </>
    );
  },
);

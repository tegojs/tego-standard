// 修复：移除不存在的 useAssociationFieldContext / useCompile 依赖，改为 useField + 组件内推断 collectionField
import { useCallback, useContext, useEffect, useMemo } from 'react';
import { action, ArrayField, exchangeArrayState, isArr, useField } from '@tachybase/schema';

import { unionBy, uniqBy } from 'lodash';

import { getLabelFormatValue, RecordPickerContext, useActionContext, useFieldNames, useLabelUiSchema } from '../..';

function buildSig(arr: any[]) {
  if (!Array.isArray(arr)) return '0';
  const len = arr.length;
  if (!len) return '0';
  const f = arr[0];
  const l = arr[len - 1];
  return `${len}:${f?.id || f?.key || ''}:${l?.id || l?.key || ''}`;
}

export interface SubTableLogicResult {
  field: any;
  collectionField: any;
  options: any[];
  fieldNames: any;
  usePickActionProps: () => { onClick: () => void };
}

export const useSubTableLogic = (props: any): SubTableLogicResult => {
  // 直接取当前字段（挂在 AssociationField 子层时可获取到）
  const field = useField<ArrayField>() as any;

  // 推断关联的 collection 定义（按你项目里常见的挂载位置做多重 fallback）
  const collectionField =
    field?.data?.collectionField ||
    field?.componentProps?.collectionField ||
    field?.componentProps?.association ||
    field?.componentProps?.options ||
    {};

  const fieldNames = useFieldNames(props) || { label: 'label' };
  const labelUiSchema = useLabelUiSchema(collectionField, fieldNames?.label || 'label');

  // 行拖拽 / 移动
  const move = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (!field) return;
      if (toIndex === undefined) return;
      if (!isArr(field.value)) return;
      if (fromIndex === toIndex) return;
      action(() => {
        const fromItem = field.value[fromIndex];
        field.value.splice(fromIndex, 1);
        field.value.splice(toIndex, 0, fromItem);
        exchangeArrayState(field, { fromIndex, toIndex });
        field.onInput(field.value);
      });
    },
    [field],
  );

  useEffect(() => {
    if (field) field.move = move;
  }, [field, move]);

  const rawArray = field ? (Array.isArray(field.value) ? field.value : field.value ? [field.value] : []) : [];

  const sig = useMemo(() => buildSig(rawArray), [rawArray]);

  // 缓存模板（无 useCompile，直接用 schema 本身）
  const compiledTemplate = labelUiSchema;

  const options = useMemo(() => {
    if (!rawArray.length) return [];
    return rawArray.map((o) => {
      const rawLabel = o?.[fieldNames.label];
      return {
        ...o,
        [fieldNames.label]: getLabelFormatValue(compiledTemplate, rawLabel),
      };
    });
  }, [sig, fieldNames?.label, compiledTemplate, rawArray]);

  const usePickActionProps = () => {
    const { setVisible } = useActionContext();
    const ctx = useContext(RecordPickerContext) as any;
    if (!ctx || !field) return { onClick: () => {} };
    const { selectedRows, options: pickerOptions, collectionField: pickerCF } = ctx;
    return {
      onClick() {
        const key = pickerCF?.targetKey || 'id';
        const selectData = unionBy(selectedRows || [], pickerOptions || [], key);
        const data = field.value || [];
        field.value = uniqBy(data.concat(selectData), key);
        field.onInput(field.value);
        setVisible && setVisible(false);
      },
    };
  };

  return { field, collectionField, options, fieldNames, usePickActionProps };
};

import React, { lazy, Profiler, Suspense, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  action,
  ArrayField,
  exchangeArrayState,
  isArr,
  observer,
  RecursionField,
  useField,
  useFieldSchema,
  useForm,
} from '@tachybase/schema';

import { Button, Tabs } from 'antd';
import { createStyles } from 'antd-style';
import { set, unionBy, uniqBy } from 'lodash';
import { useTranslation } from 'react-i18next';

import {
  FormProvider,
  RecordPickerContext,
  RecordPickerProvider,
  SchemaComponentOptions,
  useActionContext,
} from '../..';
import { useCreateActionProps } from '../../../block-provider/hooks';
import { FormActiveFieldsProvider } from '../../../block-provider/hooks/useFormActiveFields';
import { TableSelectorParamsProvider } from '../../../block-provider/TableSelectorProvider';
import { CollectionProvider_deprecated } from '../../../collection-manager';
import { CollectionRecordProvider, useCollectionRecord } from '../../../data-source';
import { markRecordAsNew } from '../../../data-source/collection-record/isNewRecord';
import { FlagProvider } from '../../../flag-provider';
import { useCompile, useDesignable } from '../../hooks';
import { ActionContextProvider } from '../action';
import { Table } from '../table-v2/Table';
import { useAssociationFieldContext, useFieldNames } from './hooks';
import { useTableSelectorProps } from './InternalPicker';
import { InternalCollapse } from './SubTabs/InternalCollapse';
import { getLabelFormatValue, useLabelUiSchema } from './util';

const useStyles = createStyles(({ css }) => {
  return {
    addNew: css`
      display: block;
      border-radius: 0px;
      border-right: 1px solid rgba(0, 0, 0, 0.06);
    `,
    select: css`
      display: block;
      border-radius: 0px;
    `,
    table: css`
      .ant-formily-item.ant-formily-item-feedback-layout-loose {
        margin-bottom: 0px !important;
      }
      .ant-formily-editable {
        vertical-align: sub;
      }
      .ant-table-footer {
        display: flex;
      }
    `,
    container: css`
      .ant-table-footer {
        padding: 0 !important;
      }
      .ant-formily-item-error-help {
        display: none;
      }
      .ant-description-textarea {
        line-height: 34px;
      }
      .ant-table-cell .ant-formily-item-error-help {
        display: block;
        position: absolute;
        font-size: 12px;
        top: 100%;
        background: #fff;
        width: 100%;
        margin-top: -15px;
        padding: 3px;
        z-index: 1;
        border-radius: 3px;
        box-shadow: 0 0 10px #eee;
        animation: none;
        transform: translateY(0);
        opacity: 1;
      }
    `,
    input: css`
      position: relative;
      .ant-input {
        width: 100%;
      }
    `,
  };
});

// filepath: /Users/zhoupeng/tego-standard/packages/client/src/schema-component/antd/association-field/SubTable.tsx
const PERF_ON = typeof process !== 'undefined' && process.env.SUBTABLE_PERF === 'on';
const LazySelector = lazy(() => import('./SubTableSelector'));

// 可调阶段时间（毫秒），支持通过环境变量覆盖
const PHASE_DELAY_1 = Number(process.env.SUBTABLE_PHASE_1 || 40); // 骨架 → 表结构
const PHASE_DELAY_2 = Number(process.env.SUBTABLE_PHASE_2 || 100); // 表结构 → 数据
const PHASE_DELAY_3 = Number(process.env.SUBTABLE_PHASE_3 || 160); // 数据 → 允许 Selector

export const SubTable: any = observer(
  (props: any) => {
    const { openSize, onDataChange } = props;
    const { styles } = useStyles();
    const { field, options: collectionField } = useAssociationFieldContext<ArrayField>();
    const subTableField = useField();
    const { t } = useTranslation();
    const fieldNames = useFieldNames(props);
    const fieldSchema = useFieldSchema();
    const compile = useCompile();
    const labelUiSchema = useLabelUiSchema(collectionField, fieldNames?.label || 'label');
    const recordV2 = useCollectionRecord();

    // -------- 阶段控制 0:骨架 1:表结构(空数据) 2:真实数据 3:选择器可用 --------
    const [phase, setPhase] = useState(0);
    const [selectorVisible, setSelectorVisible] = useState(false);
    const [selectorReady, setSelectorReady] = useState(false);

    // -------- 外部状态（保持原逻辑） --------
    const [fieldValueShadow, setFieldValueShadow] = useState<any[]>([]);
    const [selectedRows, setSelectedRows] = useState<any[]>([]);

    // -------- 安全初始化 field.value （一次）---------
    useEffect(() => {
      if (!Array.isArray(field.value)) {
        action(() => {
          field.value = Array.isArray(field.value) ? field.value : field.value ? [field.value] : [];
          field.onInput?.(field.value);
        });
      }
    }, [field]);

    // -------- 实时解析数据（不缓存引用，依赖 MobX 响应）---------
    const resolvedRecords = (() => {
      const v = field?.value;
      if (Array.isArray(v)) return v;

      return [];
    })();

    // 数据到了就提前提升阶段
    useEffect(() => {
      if (resolvedRecords.length && phase < 2) {
        setPhase(2);
      }
    }, [resolvedRecords.length, phase]);

    // 分阶段调度（如果数据未先到）
    useEffect(() => {
      if (phase > 0) return;
      const t1 = setTimeout(() => setPhase((p) => (p < 1 ? 1 : p)), PHASE_DELAY_1);
      const t2 = setTimeout(() => setPhase((p) => (p < 2 ? 2 : p)), PHASE_DELAY_2);
      const t3 = setTimeout(() => setPhase((p) => (p < 3 ? 3 : p)), PHASE_DELAY_3);
      return () => {
        clearTimeout(t1);
        clearTimeout(t2);
        clearTimeout(t3);
      };
    }, [phase]);

    // 选择器可见时才准备懒加载
    useEffect(() => {
      if (selectorVisible && !selectorReady) {
        setSelectorReady(true);
        if (phase < 3) setPhase(3);
      }
    }, [selectorVisible, selectorReady, phase]);

    // -------- 拖拽移动逻辑（memo 回调） --------
    const move = useCallback(
      async (fromIndex: number, toIndex: number): Promise<void> => {
        if (toIndex === undefined) return;
        const arr = field.value;
        if (!isArr(arr)) return;
        if (fromIndex === toIndex) return;
        action(() => {
          const fromItem = arr[fromIndex];
          arr.splice(fromIndex, 1);
          arr.splice(toIndex, 0, fromItem);
          exchangeArrayState(field, { fromIndex, toIndex });
          field.onInput?.(arr);
        });
      },
      [field],
    );
    field.move = move; // 轻量赋值

    // -------- 缓存 label 模板 --------
    const compiledLabelTemplate = useMemo(() => compile(labelUiSchema), [labelUiSchema, compile]);

    // -------- options 计算：用签名降低频率 --------
    const dataSig = useMemo(() => {
      if (!resolvedRecords.length) return '0';
      const first = resolvedRecords[0];
      const last = resolvedRecords[resolvedRecords.length - 1];
      return `${resolvedRecords.length}:${first?.id || first?.key || ''}:${last?.id || last?.key || ''}`;
    }, [resolvedRecords.length, resolvedRecords[0], resolvedRecords[resolvedRecords.length - 1]]);

    const options = useMemo(() => {
      if (!resolvedRecords.length) return [];
      return resolvedRecords.map((row) => {
        const rawLabel = row?.[fieldNames.label];
        return {
          ...row,
          [fieldNames.label]: getLabelFormatValue(compiledLabelTemplate, compile(rawLabel)),
        };
      });
    }, [resolvedRecords, fieldNames?.label, compiledLabelTemplate, compile, dataSig]);

    // -------- 监听数据变化（可选回调） --------
    useEffect(() => {
      if (!onDataChange) return;
      onDataChange(resolvedRecords, { dataSig, length: resolvedRecords.length });
    }, [resolvedRecords, dataSig, onDataChange]);

    // -------- 选择器动作 props hook --------
    const usePickActionProps = () => {
      const { setVisible } = useActionContext();
      const ctx = useContext(RecordPickerContext);
      if (!ctx) return { onClick: () => {} };
      const { selectedRows, options, collectionField: cf } = ctx;
      return {
        onClick() {
          const key = cf?.targetKey || 'id';
          const selectData = unionBy(selectedRows, options, key);
          const data = field.value || [];
          field.value = uniqBy(data.concat(selectData), key);
          field.onInput?.(field.value);
          setVisible(false);
        },
      };
    };

    // -------- 过滤器 --------
    const getFilter = useCallback(() => {
      const key = collectionField?.targetKey || 'id';
      const vals = options.map((o) => o[key]).filter(Boolean);
      return vals.length ? { $and: [{ [`${key}.$ne`]: vals }] } : {};
    }, [options, collectionField?.targetKey]);

    // -------- pickerProps / tabsProps 缓存 --------
    const pickerProps = useMemo(
      () => ({
        size: 'small',
        fieldNames: field.componentProps?.fieldNames,
        multiple: true,
        association: { target: collectionField?.target },
        options,
        onChange: props?.onChange,
        selectedRows,
        setSelectedRows,
        collectionField,
      }),
      [
        field.componentProps?.fieldNames,
        collectionField?.target,
        options,
        props?.onChange,
        selectedRows,
        collectionField,
      ],
    );

    const tabsProps = useMemo(
      () => ({ ...props, fieldValue: fieldValueShadow, setFieldValue: setFieldValueShadow }),
      [props, fieldValueShadow],
    );

    // -------- pagination 优化：传对象或 undefined --------
    const paginationProp = useMemo(() => {
      const p = field.componentProps?.pagination;
      if (!p) return undefined;
      if (p === true) return { pageSize: 20 };
      return p;
    }, [field.componentProps?.pagination]);

    // -------- 新增按钮处理（抽象成函数，减少 footer 内联函数闭包创建） --------
    const handleAddNew = useCallback(() => {
      action(() => {
        field.value = field.value || [];
        field.value.push(markRecordAsNew({}));
        const next = [...field.value];
        setFieldValueShadow(next);
        field.onInput?.(next);
      });
    }, [field]);

    // -------- Profiler 回调 --------
    const onRenderProfiler = useCallback(
      (_id: string, phaseName: any, actual: number, base: number) => {
        if (!PERF_ON) return;
        if (actual > 12) {
          // eslint-disable-next-line no-console
          console.log('[SubTablePerf]', phaseName, {
            actual: +actual.toFixed(2),
            base: +base.toFixed(2),
            rows: resolvedRecords.length,
            phase,
          });
        }
      },
      [resolvedRecords.length, phase],
    );

    // -------- 骨架 --------
    const skeleton = phase === 0 && <div style={{ padding: 8, fontSize: 12, opacity: 0.55 }}>{t('Loading...')}</div>;

    // -------- Footer 渲染（避免匿名函数） --------
    const renderFooter = useCallback(() => {
      if (!field.editable) return null;
      return (
        <>
          {field.componentProps?.allowAddnew !== false && (
            <Button type="text" block className={styles.addNew} onClick={handleAddNew}>
              {t('Add new')}
            </Button>
          )}
          {field.componentProps?.allowSelectExistingRecord && (
            <Button type="text" block className={styles.select} onClick={() => setSelectorVisible(true)}>
              {t('Select')}
            </Button>
          )}
        </>
      );
    }, [
      field.editable,
      field.componentProps?.allowAddnew,
      field.componentProps?.allowSelectExistingRecord,
      handleAddNew,
      t,
      styles.addNew,
      styles.select,
    ]);

    const paginationProps = {
      pageSize: subTableField.componentProps?.pagination?.pageSize || 5,
      current: subTableField.componentProps?.pagination?.current || 1,
      total: field.value?.length || 0,
    };
    const onChange = (props) => {
      if (subTableField && fieldSchema) {
        subTableField['componentProps'] = {
          ...subTableField.componentProps,
          pagination: props,
        };
        fieldSchema['x-component-props'] = {
          ...fieldSchema['x-component-props'],
          pagination: props,
        };
      }
    };

    // -------- 主体 --------
    const core = (
      <div className={styles.container}>
        <FlagProvider isInSubTable>
          <CollectionRecordProvider record={null} parentRecord={recordV2}>
            <FormActiveFieldsProvider name="nester">
              <InternalCollapse {...tabsProps} />
              {skeleton}
              {phase >= 1 && (
                <Table
                  className={styles.table}
                  bordered
                  onChange={onChange}
                  size="small"
                  field={field}
                  showIndex
                  dragSort={field.editable}
                  showDel={field.editable}
                  setFieldValue={setFieldValueShadow}
                  pagination={!!field.componentProps.pagination ? paginationProps : false}
                  rowSelection={{ type: 'none', hideSelectAll: true }}
                  footer={renderFooter}
                  isSubTable
                  // phase<2 先给空数组占位，>=2 让 Table 自行读取 field.value 保持响应
                  dataSourceOverride={phase < 2 ? [] : undefined}
                  cellLazyMount={phase < 2}
                  cellLazyTimeout={60}
                />
              )}
            </FormActiveFieldsProvider>
          </CollectionRecordProvider>
        </FlagProvider>

        {selectorReady && (
          <Suspense fallback={<div style={{ padding: 8, fontSize: 12, opacity: 0.6 }}>{t('Loading selector...')}</div>}>
            <LazySelector
              field={field}
              fieldSchemaParent={fieldSchema.parent}
              collectionField={collectionField}
              visible={selectorVisible}
              setVisible={setSelectorVisible}
              pickerProps={pickerProps}
              getFilter={getFilter}
              usePickActionProps={usePickActionProps}
              openSize={openSize}
            />
          </Suspense>
        )}
      </div>
    );

    if (!PERF_ON) return core;
    return (
      <Profiler id="SubTable" onRender={onRenderProfiler}>
        {core}
      </Profiler>
    );
  },
  { displayName: 'SubTable' },
);

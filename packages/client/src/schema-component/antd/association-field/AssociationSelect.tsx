import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  connect,
  mapProps,
  observer,
  onFieldInputValueChange,
  RecursionField,
  uid,
  useField,
  useFieldSchema,
  useForm,
} from '@tachybase/schema';

import { LoadingOutlined, PlusOutlined } from '@ant-design/icons';
import { App, Space } from 'antd';
import isEqual from 'lodash/isEqual';
import { isFunction } from 'mathjs';
import { useTranslation } from 'react-i18next';

import { RecordProvider, useAPIClient, useApp, useCollectionRecordData } from '../../../';
import { isVariable } from '../../../variables/utils/isVariable';
import { getInnermostKeyAndValue } from '../../common/utils/uitls';
import { RemoteSelect, RemoteSelectProps } from '../remote-select';
import useServiceOptions, { useAssociationFieldContext } from './hooks';

export type AssociationSelectProps<P = any> = RemoteSelectProps<P> & {
  action?: string;
  multiple?: boolean;
};

export const filterAnalyses = (filters): any[] => {
  if (!filters) return;
  const type = Object.keys(filters)[0] || '$and';
  const conditions = filters[type];
  const results = [];
  conditions?.map((c) => {
    const jsonlogic = getInnermostKeyAndValue(c);
    const operator = jsonlogic?.key;
    if (!operator) return true;
    const regex = /\{\{\$(?:[a-zA-Z_]\w*)\.([a-zA-Z_]\w*)(?:\.id)?\}\}/;
    const fieldName = jsonlogic?.value?.match?.(regex)?.[1];
    if (fieldName) results.push(fieldName);
  });
  return results;
};

const InternalAssociationSelect = observer(
  (props: AssociationSelectProps) => {
    const { objectValue = true, onChange: onChangeProp, value: propValue, ...restProps } = props;
    const { message } = App.useApp();
    const field: any = useField();
    const fieldSchema = useFieldSchema();
    const service = useServiceOptions(props);
    const { options: collectionField } = useAssociationFieldContext();

    const memoValue = useMemo(() => {
      const init = isVariable(propValue) ? undefined : propValue;
      return Array.isArray(init) ? init.filter(Boolean) : init;
    }, [propValue]);

    const [innerValue, setInnerValue] = useState(memoValue);
    const addMode = fieldSchema['x-component-props']?.addMode;
    const isAllowAddNew = fieldSchema['x-add-new'];
    const { t } = useTranslation();
    const { multiple } = props;
    const form = useForm();
    const api = useAPIClient();
    const recordData = useCollectionRecordData();

    const resource = useMemo(() => api.resource(collectionField.target), [api, collectionField.target]);

    const linkageFields = useMemo(
      () => filterAnalyses(field.componentProps?.service?.params?.filter),
      [field.componentProps?.service?.params?.filter],
    );

    // 计时：仅在关键签名变化时记录，避免每次渲染都记整帧时长
    const displayValue = memoValue ?? innerValue;
    const serviceSig = useMemo(() => {
      try {
        const target = collectionField?.target;
        const action = props.action ?? 'list';
        const params = field?.componentProps?.service?.params || service?.params || {};
        return JSON.stringify({ target, action, params });
      } catch {
        return String(collectionField?.target ?? 'target');
      }
    }, [collectionField?.target, props.action, field?.componentProps?.service?.params, service?.params]);

    const valueSig = useMemo(() => {
      try {
        return JSON.stringify(displayValue);
      } catch {
        return String(displayValue ?? 'v');
      }
    }, [displayValue]);

    const renderSig = useMemo(
      () => [serviceSig, valueSig, multiple ? 1 : 0, String(addMode), isAllowAddNew ? 1 : 0].join('|'),
      [serviceSig, valueSig, multiple, addMode, isAllowAddNew],
    );

    // const computeStartTimeRef = useRef(0);
    // useEffect(() => {
    //   computeStartTimeRef.current = performance.now();
    //   const computeEndTime = performance.now() - computeStartTimeRef.current;
    //   console.log(`[RecordItemCount] 计算完成时间: ${computeEndTime.toFixed(2)}ms`);
    //   const domUpdateTime = performance.now();
    //   console.log(
    //     `[RecordItemCount] DOM更新完成时间InternalAssociationSelect: ${(domUpdateTime - computeStartTimeRef.current).toFixed(2)}ms`,
    //   );
    //   const animationFrameId = requestAnimationFrame(() => {
    //     const renderTime = performance.now();
    //     console.log(
    //       `[RecordItemCount] 渲染到页面时间InternalAssociationSelect: ${(renderTime - computeStartTimeRef.current).toFixed(2)}ms`,
    //     );
    //   });
    //   return () => cancelAnimationFrame(animationFrameId);
    // }, [renderSig]);

    // 同步外部 field.value 到内部，仅在变更时更新
    useEffect(() => {
      const init = isVariable(field.value) ? undefined : field.value;
      const next = Array.isArray(init) ? init.filter(Boolean) : init;
      setInnerValue((prev) => (isEqual(prev, next) ? prev : next));
    }, [field.value]);

    // 处理联动：仅注册一次，依赖集保持最小
    useEffect(() => {
      const id = uid();
      form.addEffects(id, () => {
        if (linkageFields?.length > 0) {
          onFieldInputValueChange('*', (fieldPath: any) => {
            if (linkageFields.includes(fieldPath.props.name) && field.value) {
              if (!isEqual(field.initialValue, field.value)) {
                onChangeProp?.(field.initialValue);
                setInnerValue(field.initialValue);
              }
            }
          });
        }
      });
      return () => {
        form.removeEffects(id);
      };
    }, [form, linkageFields, onChangeProp, field.value, field.initialValue]);

    const handleCreateAction = useCallback(
      async (p: any) => {
        const { search: value, callBack } = p;
        const {
          data: { data },
        } = await resource.create({
          values: {
            [field?.componentProps?.fieldNames?.label || 'id']: value,
          },
        });
        if (data) {
          if (['m2m', 'o2m'].includes(collectionField?.interface) && multiple !== false) {
            const values = form.getValuesIn(field.path) || [];
            values.push(data);
            form.setValuesIn(field.path, values);
            field.onInput(values);
          } else {
            form.setValuesIn(field.path, data);
            field.onInput(data);
          }
          isFunction(callBack) && callBack?.();
          message.success(t('Saved successfully'));
        }
      },
      [
        resource,
        field?.componentProps?.fieldNames?.label,
        collectionField?.interface,
        multiple,
        form,
        field,
        message,
        t,
      ],
    );

    const QuickAddContent = memo((p: any) => {
      return (
        <div onClick={() => handleCreateAction(p)} style={{ cursor: 'pointer', padding: '5px 12px', color: '#0d0c0c' }}>
          <PlusOutlined />
          <span style={{ paddingLeft: 5 }}>{t('Add') + ` “${p.search}” `}</span>
        </div>
      );
    });

    const handleChange = useCallback(
      (val: any) => {
        const v = val?.length !== 0 ? val : null;
        onChangeProp?.(v);
      },
      [onChangeProp],
    );

    const dropdownRenderMemo = useMemo(
      () => (addMode === 'quickAdd' ? QuickAddContent : undefined),
      [addMode, QuickAddContent],
    );
    const remoteSelectStyle = useMemo(() => ({ width: '100%' }), []);

    return (
      <div>
        <Space.Compact style={{ display: 'flex', lineHeight: '32px' }}>
          <RemoteSelect
            style={remoteSelectStyle}
            {...restProps}
            size={'middle'}
            objectValue={objectValue}
            value={displayValue}
            service={service}
            onChange={handleChange}
            CustomDropdownRender={dropdownRenderMemo}
          />
          {(addMode === 'modalAdd' || isAllowAddNew) && (
            <RecordProvider isNew={true} record={null} parent={recordData}>
              <RecursionField
                onlyRenderProperties
                basePath={field.address}
                schema={fieldSchema}
                filterProperties={(s) => s['x-component'] === 'Action'}
              />
            </RecordProvider>
          )}
        </Space.Compact>
      </div>
    );
  },
  { displayName: 'AssociationSelect' },
);

interface AssociationSelectInterface {
  (props: any): React.ReactElement;
  Designer: React.FC;
  FilterDesigner: React.FC;
}

// 仅比较与渲染相关的关键 props，避免父级无关变更触发重渲
const arePropsEqual = (prev: any, next: any) => {
  return (
    prev.value === next.value &&
    prev.multiple === next.multiple &&
    prev.action === next.action &&
    prev.disabled === next.disabled &&
    prev.allowClear === next.allowClear &&
    isEqual(prev.fieldNames, next.fieldNames)
  );
};

export const AssociationSelect = React.memo(
  InternalAssociationSelect,
  arePropsEqual,
) as unknown as AssociationSelectInterface;

export const AssociationSelectReadPretty = connect(
  (props: any) => {
    const service = useServiceOptions(props);
    const app = useApp();
    if (props.fieldNames) {
      return <RemoteSelect.ReadPretty {...props} service={service} />;
    }
    return null;
  },
  mapProps(
    {
      dataSource: 'options',
      loading: true,
    },
    (props, field) => {
      return {
        ...props,
        fieldNames: props.fieldNames && { ...props.fieldNames, ...field.componentProps.fieldNames },
        suffixIcon: field?.['loading'] || field?.['validating'] ? <LoadingOutlined /> : props.suffixIcon,
      };
    },
  ),
);

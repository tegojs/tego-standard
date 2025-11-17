import React, { useContext, useEffect, useMemo, useRef } from 'react';
import { Field, observer, SchemaOptionsContext, useField, useForm } from '@tachybase/schema';

import _ from 'lodash';

import { SchemaComponentOptions } from '../../';
import { useAssociationCreateActionProps as useCAP } from '../../../block-provider/hooks';
import { useCollection_deprecated } from '../../../collection-manager';
import { AssociationFieldProvider } from './AssociationFieldProvider';
import { AssociationSelect as Select } from './AssociationSelect';
import { CreateRecordAction } from './components/CreateRecordAction';
import { InternalFileManager } from './FileManager';
import { useAssociationFieldContext } from './hooks';
import { InternalCascader } from './InternalCascader';
import { InternalCascadeSelect } from './InternalCascadeSelect';
import { InternaDrawerSubTable } from './InternalDrawerSubTable';
import { InternalNester } from './InternalNester';
import { InternalPicker } from './InternalPicker';
import { InternaPopoverNester } from './InternalPopoverNester';
import { InternalSubTable } from './InternalSubTable';

// 动态模式组件类型统一宽化为 any，保障运行期 Schema 注入的灵活性
interface EditableAssociationFieldProps {
  multiple?: boolean;
  value?: any;
  action?: string;
  disabled?: boolean;
  allowClear?: boolean;
  [key: string]: any;
}

const EditableAssociationFieldBase = observer((props: EditableAssociationFieldProps) => {
  const { multiple } = props;
  const field: Field = useField();
  const form = useForm();
  const { options: collectionField, currentMode } = useAssociationFieldContext();
  const { components } = useContext(SchemaOptionsContext);
  const AssociationSelect = _.get(components, 'AlternativeAssociationSelect') || Select;

  const useCreateActionProps = () => {
    const { onClick } = useCAP();
    const actionField: any = useField();
    const { getPrimaryKey } = useCollection_deprecated();
    const primaryKey = getPrimaryKey();
    return {
      async onClick() {
        await onClick();
        const { data } = actionField.data?.data?.data || {};
        if (data) {
          if (['m2m', 'o2m'].includes(collectionField?.interface) && multiple !== false) {
            const values = form.getValuesIn(field.path) || [];
            if (!values.find((v) => v[primaryKey] === data[primaryKey])) {
              values.push(data);
              form.setValuesIn(field.path, values);
              field.onInput(values);
            }
          } else {
            form.setValuesIn(field.path, data);
            field.onInput(data);
          }
        }
      },
    };
  };

  const renderSig = useMemo(
    () => [currentMode || '', collectionField?.interface || '', multiple ? 1 : 0].join('|'),
    [currentMode, collectionField?.interface, multiple],
  );

  // const computeStartTimeRef = useRef(0);
  // useEffect(() => {
  //   computeStartTimeRef.current = performance.now();
  //   const computeEndTime = performance.now() - computeStartTimeRef.current;
  //   console.log(`[RecordItemCount] 计算完成时间: ${computeEndTime.toFixed(2)}ms`);
  //   const domUpdateTime = performance.now();
  //   console.log(
  //     `[RecordItemCount] DOM更新完成时间 EditableAssociationField: ${(domUpdateTime - computeStartTimeRef.current).toFixed(2)}ms`,
  //     { currentMode, multiple, iface: collectionField?.interface },
  //   );
  //   const animationFrameId = requestAnimationFrame(() => {
  //     const renderTime = performance.now();
  //     console.log(
  //       `[RecordItemCount] 渲染到页面时间 EditableAssociationField: ${(renderTime - computeStartTimeRef.current).toFixed(2)}ms`,
  //     );
  //   });
  //   return () => cancelAnimationFrame(animationFrameId);
  // }, [renderSig, currentMode, multiple, collectionField?.interface]);

  const modeComponentMap: Record<string, React.ComponentType<any>> = {
    Picker: InternalPicker as any,
    Nester: InternalNester as any,
    PopoverNester: InternaPopoverNester as any,
    Select: AssociationSelect as any,
    CustomTitle: AssociationSelect as any,
    SubTable: InternalSubTable as any,
    FileManager: InternalFileManager as any,
    CascadeSelect: InternalCascadeSelect as any,
    DrawerSubTable: InternaDrawerSubTable as any,
    Cascader: InternalCascader as any,
  };

  const ModeComponent = modeComponentMap[currentMode];

  return (
    <SchemaComponentOptions scope={{ useCreateActionProps }} components={{ CreateRecordAction }}>
      {ModeComponent ? <ModeComponent {...(props as any)} /> : null}
    </SchemaComponentOptions>
  );
});

const areEditablePropsEqual = (prev: EditableAssociationFieldProps, next: EditableAssociationFieldProps) => {
  return (
    prev.multiple === next.multiple &&
    prev.value === next.value &&
    prev.action === next.action &&
    prev.disabled === next.disabled &&
    prev.allowClear === next.allowClear
  );
};

const EditableAssociationField = React.memo(EditableAssociationFieldBase, areEditablePropsEqual);

export const Editable = observer(
  (props) => (
    <AssociationFieldProvider>
      <EditableAssociationField {...props} />
    </AssociationFieldProvider>
  ),
  { displayName: 'Editable' },
);

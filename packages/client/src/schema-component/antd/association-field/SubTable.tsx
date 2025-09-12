import React, { useContext, useEffect, useMemo, useState } from 'react';
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

import { useAsyncEffect } from 'ahooks';
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
import { useAPIClient, useRequest } from '../../../api-client';
import { useCreateActionProps } from '../../../block-provider/hooks';
import { FormActiveFieldsProvider } from '../../../block-provider/hooks/useFormActiveFields';
import { TableSelectorParamsProvider } from '../../../block-provider/TableSelectorProvider';
import { CollectionProvider_deprecated } from '../../../collection-manager';
import { CollectionRecordProvider, useCollectionManager, useCollectionRecord } from '../../../data-source';
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

export const SubTable: any = observer(
  (props: any) => {
    const { openSize } = props;
    const { styles } = useStyles();
    const { field, options: collectionField } = useAssociationFieldContext<ArrayField>();
    const subTableField = useField();
    const { t } = useTranslation();
    const [visibleSelector, setVisibleSelector] = useState(false);
    const [selectedRows, setSelectedRows] = useState([]);
    const fieldNames = useFieldNames(props);
    const fieldSchema = useFieldSchema();
    const compile = useCompile();
    const labelUiSchema = useLabelUiSchema(collectionField, fieldNames?.label || 'label');
    const recordV2 = useCollectionRecord();
    const [fieldValue, setFieldValue] = useState([]);
    const move = (fromIndex: number, toIndex: number) => {
      if (toIndex === undefined) return;
      if (!isArr(field.value)) return;
      if (fromIndex === toIndex) return;
      return action(() => {
        const fromItem = field.value[fromIndex];
        field.value.splice(fromIndex, 1);
        field.value.splice(toIndex, 0, fromItem);
        exchangeArrayState(field, {
          fromIndex,
          toIndex,
        });
        return field.onInput(field.value);
      });
    };
    const { dn } = useDesignable();

    field.move = move;

    const options = useMemo(() => {
      if (field.value && Object.keys(field.value).length > 0) {
        const opts = (Array.isArray(field.value) ? field.value : field.value ? [field.value] : [])
          .filter(Boolean)
          .map((option) => {
            const label = option?.[fieldNames.label];
            return {
              ...option,
              [fieldNames.label]: getLabelFormatValue(compile(labelUiSchema), compile(label)),
            };
          });
        return opts;
      }
      return [];
    }, [field.value, fieldNames?.label]);

    const pickerProps = {
      size: 'small',
      fieldNames: field.componentProps.fieldNames,
      multiple: true,
      association: {
        target: collectionField?.target,
      },
      options,
      onChange: props?.onChange,
      selectedRows,
      setSelectedRows,
      collectionField,
    };
    const usePickActionProps = () => {
      const { setVisible } = useActionContext();
      const { selectedRows, options, collectionField } = useContext(RecordPickerContext);
      return {
        onClick() {
          const selectData = unionBy(selectedRows, options, collectionField?.targetKey || 'id');
          const data = field.value || [];
          field.value = uniqBy(data.concat(selectData), collectionField?.targetKey || 'id');
          field.onInput(field.value);
          setVisible(false);
        },
      };
    };
    const getFilter = () => {
      const targetKey = collectionField?.targetKey || 'id';
      const list = options.map((option) => option[targetKey]).filter(Boolean);
      const filter = list.length ? { $and: [{ [`${targetKey}.$ne`]: list }] } : {};
      return filter;
    };
    const tabsProps = {
      ...props,
      fieldValue,
      setFieldValue,
    };

    const paginationProps = {
      pageSize: subTableField.componentProps?.pagination?.pageSize || 5,
      current: subTableField.componentProps?.pagination?.current || 1,
      total: field.value.length,
    };
    const onChange = (props) => {
      subTableField.componentProps['pagination'] = {
        ...subTableField.componentProps['pagination'],
        current: props.current,
      };
      if (subTableField.componentProps.pagination.pageSize !== props.pageSize) {
        subTableField.componentProps.pagination.pageSize = props.pageSize;
        fieldSchema['x-component-props'] = {
          ...fieldSchema['x-component-props'],
          pagination: {
            ...fieldSchema['x-component-props']?.['pagination'],
            pageSize: props.pageSize,
          },
        };
        dn.emit('patch', {
          schema: {
            'x-uid': fieldSchema['x-uid'],
            'x-component-props': {
              ...fieldSchema['x-component-props'],
              pagination: {
                pageSize: props.pageSize,
              },
            },
          },
        });
      }
    };
    return (
      <div className={styles.container}>
        <FlagProvider isInSubTable>
          <CollectionRecordProvider record={null} parentRecord={recordV2}>
            <FormActiveFieldsProvider name="nester">
              <InternalCollapse {...tabsProps} />
              <Table
                className={styles.table}
                bordered
                onChange={onChange}
                size={'small'}
                field={field}
                showIndex
                dragSort={field.editable}
                showDel={field.editable}
                setFieldValue={setFieldValue}
                pagination={!!field.componentProps.pagination ? paginationProps : false}
                rowSelection={{ type: 'none', hideSelectAll: true }}
                footer={() =>
                  field.editable && (
                    <>
                      {field.componentProps?.allowAddnew !== false && (
                        <Button
                          type={'text'}
                          block
                          className={styles.addNew}
                          onClick={() => {
                            field.value = field.value || [];
                            field.value.push(markRecordAsNew({}));
                            setFieldValue([...field.value]);
                          }}
                        >
                          {t('Add new')}
                        </Button>
                      )}
                      {field.componentProps?.allowSelectExistingRecord && (
                        <Button
                          type={'text'}
                          block
                          className={styles.select}
                          onClick={() => {
                            setVisibleSelector(true);
                          }}
                        >
                          {t('Select')}
                        </Button>
                      )}
                    </>
                  )
                }
                isSubTable={true}
              />
            </FormActiveFieldsProvider>
          </CollectionRecordProvider>
        </FlagProvider>
        <ActionContextProvider
          value={{
            openSize,
            openMode: 'drawer',
            visible: visibleSelector,
            setVisible: setVisibleSelector,
          }}
        >
          <RecordPickerProvider {...pickerProps}>
            <CollectionProvider_deprecated name={collectionField?.target}>
              <FormProvider>
                <TableSelectorParamsProvider params={{ filter: getFilter() }}>
                  <SchemaComponentOptions
                    scope={{
                      usePickActionProps,
                      useTableSelectorProps,
                      useCreateActionProps,
                    }}
                  >
                    <RecursionField
                      onlyRenderProperties
                      basePath={field.address}
                      schema={fieldSchema.parent}
                      filterProperties={(s) => {
                        return s['x-component'] === 'AssociationField.Selector';
                      }}
                    />
                  </SchemaComponentOptions>
                </TableSelectorParamsProvider>
              </FormProvider>
            </CollectionProvider_deprecated>
          </RecordPickerProvider>
        </ActionContextProvider>
      </div>
    );
  },
  { displayName: 'SubTable' },
);

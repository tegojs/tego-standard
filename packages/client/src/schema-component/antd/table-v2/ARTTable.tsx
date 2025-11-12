import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  action,
  ArrayField,
  observer,
  RecursionField,
  Schema,
  spliceArrayState,
  uid,
  useField,
  useFieldSchema,
} from '@tachybase/schema';
import { isPortalInBody } from '@tego/client';

import { CopyOutlined, DeleteOutlined, MenuOutlined } from '@ant-design/icons';
import { SortableContext, SortableContextProps, useSortable } from '@dnd-kit/sortable';
import { useMemoizedFn } from 'ahooks';
import { ArtColumn, BaseTable } from 'ali-react-table';
import { TableColumnProps } from 'antd';
import { default as classNames, default as cls } from 'classnames';
import _, { each } from 'lodash';
import { useTranslation } from 'react-i18next';

import { useToken } from '../__builtins__';
import { DndContext, useDesignable, useTableSize } from '../..';
import {
  RecordIndexProvider,
  RecordProvider,
  useACLFieldWhitelist,
  useCollection,
  useCollection_deprecated,
  useCollectionParentRecordData,
  useSchemaInitializerRender,
  useTableBlockContext,
  useTableSelectorContext,
} from '../../../';
import { withDynamicSchemaProps } from '../../../application/hoc/withDynamicSchemaProps';
import { isNewRecord, markRecordAsNew } from '../../../data-source/collection-record/isNewRecord';
import { DeclareVariable } from '../../../modules/variable/DeclareVariable';
import { SubFormProvider } from '../association-field/hooks';
import { ColumnFieldProvider } from './components/ColumnFieldProvider';
import { useStyles } from './Table.styles';
import { extractIndex, isCollectionFieldComponent, isColumnComponent } from './utils';

import './ARTTable.less';

export const useArrayField = (props) => {
  const field = useField<ArrayField>();
  return (props.field || field) as ArrayField;
};

export const useTableColumns = (props: { showDel?: boolean; isSubTable?: boolean; setFieldValue?: any }) => {
  const { t } = useTranslation();
  const { styles } = useStyles();
  const field = useArrayField(props);
  const schema = useFieldSchema();
  const { schemaInWhitelist } = useACLFieldWhitelist();
  const { designable } = useDesignable();
  const { exists, render } = useSchemaInitializerRender(schema['x-initializer'], schema['x-initializer-props']);
  const parentRecordData = useCollectionParentRecordData();
  const collection = useCollection();

  const dataSource = field?.value?.slice?.()?.filter?.(Boolean) || [];
  const columns = schema
    .reduceProperties((buf, s) => {
      if (isColumnComponent(s) && schemaInWhitelist(Object.values(s.properties || {}).pop())) {
        return buf.concat([s]);
      }
      return buf;
    }, [])
    ?.map((s: Schema) => {
      const collectionFields = s.reduceProperties((buf, s) => {
        if (isCollectionFieldComponent(s)) {
          return buf.concat([s]);
        }
      }, []);
      const dataIndex = collectionFields?.length > 0 ? collectionFields[0].name : s.name;
      return {
        title: <RecursionField name={s.name} schema={s} onlyRenderSelf />,
        dataIndex,
        key: s.name,
        sorter: s['x-component-props']?.['sorter'],
        width: 200,
        ...s['x-component-props'],
        render: (v, record) => {
          const index = field.value?.indexOf(record);
          return (
            <DeclareVariable
              name="$nPopupRecord"
              title={t('Current popup record')}
              value={record}
              collection={collection}
            >
              <SubFormProvider value={{ value: record, collection }}>
                <RecordIndexProvider index={record.__index || index}>
                  <RecordProvider isNew={isNewRecord(record)} record={record} parent={parentRecordData}>
                    <ColumnFieldProvider schema={s} basePath={field.address.concat(record.__index || index)}>
                      <span role="button" className={styles.toolbar}>
                        <RecursionField
                          basePath={field.address.concat(record.__index || index)}
                          schema={s}
                          onlyRenderProperties
                        />
                      </span>
                    </ColumnFieldProvider>
                  </RecordProvider>
                </RecordIndexProvider>
              </SubFormProvider>
            </DeclareVariable>
          );
        },
      } as TableColumnProps<any>;
    });
  if (!exists) {
    return columns;
  }

  const tableColumns = columns.concat({
    title: render(),
    fixed: 'right',
    dataIndex: 'TABLE_COLUMN_INITIALIZER',
    key: 'TABLE_COLUMN_INITIALIZER',
    render: designable ? () => <span /> : null,
  });

  if (props.showDel) {
    tableColumns.push({
      title: '',
      key: 'delete',
      width: 60,
      align: 'center',
      fixed: 'right',
      render: (v, record, index) => {
        return (
          <>
            <CopyOutlined
              style={{ cursor: 'pointer', marginRight: '10px' }}
              onClick={() => {
                action(() => {
                  if (!Array.isArray(field.value)) {
                    field.value = [];
                  }
                  spliceArrayState(field as any, {
                    startIndex: index + 1,
                    insertCount: 1,
                  });
                  field.value.splice(index + 1, 0, markRecordAsNew(_.cloneDeep(record)));
                  each(field.form.fields, (targetField, key) => {
                    if (!targetField) {
                      delete field.form.fields[key];
                    }
                  });
                  return field.onInput(field.value);
                });
              }}
            />
            <DeleteOutlined
              style={{ cursor: 'pointer' }}
              onClick={() => {
                action(() => {
                  const index = dataSource.indexOf(record);
                  spliceArrayState(field as any, {
                    startIndex: index,
                    deleteCount: 1,
                  });
                  field.value.splice(index, 1);
                  field.initialValue?.splice(index, 1);
                  props.setFieldValue([...field.value]);
                  return field.onInput(field.value);
                });
              }}
            />
          </>
        );
      },
    });
  }

  return [
    ...tableColumns.filter((column) => column.fixed === 'left'),
    ...tableColumns.filter((column) => !column.fixed || (column.fixed !== 'left' && column.fixed !== 'right')),
    ...tableColumns.filter((column) => column.fixed === 'right'),
  ];
};

const SortableRow = (props) => {
  const { styles } = useStyles();
  const id = props['data-row-key']?.toString();
  const { setNodeRef, isOver, active, over } = useSortable({
    id,
  });

  const className =
    (active?.data.current?.sortable.index ?? -1) > (over?.data.current?.sortable?.index ?? -1)
      ? styles.topActive
      : styles.bottomActive;

  return (
    <tr
      ref={active?.id !== id ? setNodeRef : null}
      {...props}
      className={classNames(props.className, { [className]: active && isOver })}
    />
  );
};

const SortHandle = (props) => {
  const { id, ...otherProps } = props;
  const { listeners } = useSortable({
    id,
  });
  return <MenuOutlined {...otherProps} {...listeners} style={{ cursor: 'grab' }} />;
};

const TableIndex = (props) => {
  const { index, ...otherProps } = props;
  return (
    <div className={classNames('tb-table-index')} style={{ padding: '0 8px 0 16px' }} {...otherProps}>
      {index}
    </div>
  );
};

const pageSizeOptions = [5, 10, 20, 50, 100, 200];
const usePaginationProps = (pagination1, pagination2) => {
  const { t } = useTranslation();
  const showTotal = useCallback((total) => t('Total {{count}} items', { count: total }), [t]);
  if (pagination2 === false) {
    return false;
  }
  if (!pagination2 && pagination1 === false) {
    return false;
  }
  const result = {
    showTotal,
    showSizeChanger: true,
    pageSizeOptions,
    ...pagination1,
    ...pagination2,
  };
  return result.total ? result : false;
};

/**
 * 将 antd 风格列映射为 ali-react-table 列，保留原 schema 解析(title/render)
 */
function toArtColumns(
  antdCols: any[],
  opts: {
    showIndex: boolean;
    isRowSelect: boolean;
    getRowKey: (r: any) => string;
    selectedRowKeys: any[];
    pagination?: { current?: number; pageSize?: number };
  },
): ArtColumn[] {
  const { showIndex, isRowSelect, getRowKey, selectedRowKeys, pagination } = opts;
  const mapped: ArtColumn[] = (antdCols || []).map((col, i) => {
    const dataIndex = col.dataIndex;
    const code = (Array.isArray(dataIndex) ? dataIndex.join('.') : dataIndex) || col.key || `col_${i}`;
    return {
      code: String(code),
      name: col.title,
      width: col.width,
      align: col.align,
      features: { fixed: col.fixed },
      render: (val: any, record: any, rowIndex: number) => {
        // 与 antd render(v, record, index) 保持一致的 v 取值
        let cellVal = val;
        if (cellVal === undefined && dataIndex) {
          if (Array.isArray(dataIndex)) {
            cellVal = dataIndex.reduce((acc, k) => (acc == null ? acc : acc[k]), record);
          } else {
            cellVal = record?.[dataIndex];
          }
        }
        return col.render ? col.render(cellVal, record, rowIndex) : cellVal;
      },
    } as ArtColumn;
  });

  // 前置索引/选择指示列（与原 rowSelection.renderCell + showIndex 的视觉位对齐）
  if (showIndex || isRowSelect) {
    mapped.unshift({
      code: '__meta',
      name: '',
      width: 56,
      align: 'left',
      render: (_: any, record: any, rowIndex: number) => {
        const current = pagination?.current ?? 1;
        const pageSize = pagination?.pageSize ?? 20;
        const absIndex = (current - 1) * pageSize + rowIndex + 1;
        const checked = selectedRowKeys.includes(getRowKey(record));
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {/* 拖拽图标占位，后续可接入 dnd-kit 交互 */}
            <MenuOutlined style={{ cursor: 'grab', opacity: 0.6 }} />
            {showIndex && (
              <span style={{ padding: '0 6px 0 2px' }}>{record.__index ? extractIndex(record.__index) : absIndex}</span>
            )}
            {isRowSelect && (
              <span
                aria-label="row-select-indicator"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 8,
                  background: checked ? '#1677ff' : '#d9d9d9',
                  display: 'inline-block',
                }}
              />
            )}
          </div>
        );
      },
    });
  }
  return mapped;
}

export const ARTTable: any = withDynamicSchemaProps(
  observer(
    (props: {
      useProps?: () => any;
      onChange?: (pagination, filters, sorter, extra) => void;
      onRowSelectionChange?: (selectedRowKeys: any[], selectedRows: any[]) => void;
      onRowDragEnd?: (e: { from: any; to: any }) => void;
      onClickRow?: (record: any, setSelectedRow: (selectedRow: any[]) => void, selectedRow: any[]) => void;
      pagination?: any;
      showIndex?: boolean;
      dragSort?: boolean;
      rowKey?: string | ((record: any) => string);
      rowSelection?: any;
      required?: boolean;
      onExpand?: (flag: boolean, record: any) => void;
      isSubTable?: boolean;
      footer?: (() => React.ReactNode) | React.ReactNode; // 兼容 antd Table footer
    }) => {
      const { token } = useToken();
      const { styles } = useStyles();
      const { pagination: pagination1, useProps, ...others1 } = props;

      const { pagination: pagination2, ...others2 } = useProps?.() || {};

      const {
        dragSort: tableDragSort,
        showIndex = true,
        onRowSelectionChange,
        onChange: onTableChange,
        rowSelection,
        rowKey,
        required,
        onExpand,
        onClickRow,
        footer, // 透出 footer
        ...others
      } = { ...others1, ...others2 } as any;

      const field = useArrayField(others);
      const columns = useTableColumns(others);
      const schema = useFieldSchema();
      const collection = useCollection_deprecated();
      const isTableSelector = schema?.parent?.['x-decorator'] === 'TableSelectorProvider';
      const ctx = isTableSelector ? useTableSelectorContext() : useTableBlockContext();
      const { expandFlag, allIncludesChildren } = ctx;
      const onRowDragEnd = useMemoizedFn(others.onRowDragEnd || (() => {}));
      const paginationProps = usePaginationProps(pagination1, pagination2);
      const [expandedKeys, setExpandesKeys] = useState([]);
      const [selectedRowKeys, setSelectedRowKeys] = useState<any[]>(field?.data?.selectedRowKeys || []);
      const [selectedRow, setSelectedRow] = useState([]);
      const dataSource = field?.value?.slice?.()?.filter?.(Boolean) || [];
      const dragSort = tableDragSort || field.componentProps.dragSort || false;
      const defaultRowKeyMap = useRef(new Map());

      let onRow = null,
        highlightRow = '';

      // 兼容 antd Table 的 footer：支持函数或节点
      const footerNode = useMemo(() => {
        if (!footer) return null;
        return typeof footer === 'function' ? (footer as () => React.ReactNode)() : footer;
      }, [footer]);

      if (onClickRow) {
        onRow = (record) => {
          return {
            onClick: (e) => {
              if (isPortalInBody(e.target)) {
                return;
              }
              onClickRow(record, setSelectedRow, selectedRow);
            },
          };
        };
        highlightRow = styles.highlightRow;
      }

      useEffect(() => {
        if (expandFlag) {
          setExpandesKeys(allIncludesChildren);
        } else {
          setExpandesKeys([]);
        }
      }, [expandFlag, allIncludesChildren]);

      // ali-react-table 不复用 antd 的 components，自定义拖拽将另行接入（此处先移除）
      /**
       * 为没有设置 key 属性的表格行生成一个唯一的 key
       * 1. rowKey 的默认值是 “key”，所以先判断有没有 record.key；
       * 2. 如果没有就生成一个唯一的 key，并以 record 的值作为索引；
       * 3. 这样下次就能取到对应的 key 的值；
       *
       * 这里有效的前提是：数组中对应的 record 的引用不会发生改变。
       *
       * @param record
       * @returns
       */
      const defaultRowKey = (record: any) => {
        if (record.key) {
          return record.key;
        }

        if (defaultRowKeyMap.current.has(record)) {
          return defaultRowKeyMap.current.get(record);
        }

        const key = uid();
        defaultRowKeyMap.current.set(record, key);
        return key;
      };

      const getRowKey = (record: any) => {
        if (typeof rowKey === 'string') {
          return record[rowKey]?.toString();
        } else {
          return (rowKey ?? defaultRowKey)(record)?.toString();
        }
      };

      // BaseTable 无 rowSelection 属性，这里改为“点击行切换”
      const isRowSelect = rowSelection?.type !== 'none';
      const handleRowToggle = useCallback(
        (record: any) => {
          if (!isRowSelect) return;
          const key = getRowKey(record);
          const existed = selectedRowKeys.includes(key);
          const nextKeys = existed ? selectedRowKeys.filter((k) => k !== key) : [...selectedRowKeys, key];
          const nextRows = (field?.value || []).filter((r) => nextKeys.includes(getRowKey(r)));
          field.data = field.data || {};
          field.data.selectedRowKeys = nextKeys;
          setSelectedRowKeys(nextKeys);
          onRowSelectionChange?.(nextKeys, nextRows);
        },
        [isRowSelect, selectedRowKeys, field, getRowKey, onRowSelectionChange],
      );

      const restProps = {
        // rowSelection: rowSelection
        //   ? {
        //       type: 'checkbox',
        //       selectedRowKeys: selectedRowKeys,
        //       onChange(selectedRowKeys: any[], selectedRows: any[]) {
        //         field.data = field.data || {};
        //         field.data.selectedRowKeys = selectedRowKeys;
        //         setSelectedRowKeys(selectedRowKeys);
        //         onRowSelectionChange?.(selectedRowKeys, selectedRows);
        //       },
        //       getCheckboxProps(record) {
        //         return {
        //           'aria-label': `checkbox`,
        //         };
        //       },
        //       renderCell: (checked, record, index, originNode) => {
        //         if (!dragSort && !showIndex) {
        //           return originNode;
        //         }
        //         const current = props?.pagination?.current;
        //         const pageSize = props?.pagination?.pageSize || 20;
        //         if (current) {
        //           index = index + (current - 1) * pageSize + 1;
        //         } else {
        //           index = index + 1;
        //         }
        //         if (record.__index) {
        //           index = extractIndex(record.__index);
        //         }
        //         return (
        //           <div
        //             role="button"
        //             aria-label={`table-index-${index}`}
        //             className={classNames(checked ? 'checked' : null, styles.rowSelect, {
        //               [styles.rowSelectHover]: isRowSelect,
        //             })}
        //           >
        //             <div className={classNames(checked ? 'checked' : null, styles.cellChecked)}>
        //               {dragSort && <SortHandle id={getRowKey(record)} />}
        //               {showIndex && <TableIndex index={index} />}
        //             </div>
        //             {isRowSelect && (
        //               <div className={classNames('tb-origin-node', checked ? 'checked' : null, styles.cellCheckedNode)}>
        //                 {originNode}
        //               </div>
        //             )}
        //           </div>
        //         );
        //       },
        //       ...rowSelection,
        //     }
        //   : undefined,
      };
      const SortableWrapper = useCallback(
        ({ children }) => {
          return dragSort
            ? React.createElement<Omit<SortableContextProps, 'children'>>(
                SortableContext,
                {
                  items: field.value?.map?.(getRowKey) || [],
                },
                children,
              )
            : React.createElement(React.Fragment, {}, children);
        },
        [field, dragSort],
      );
      const fieldSchema = useFieldSchema();
      const fixedBlock = fieldSchema?.parent?.['x-decorator-props']?.fixedBlock;

      const { height: tableHeight, tableSizeRefCallback } = useTableSize();

      // BaseTable 通过容器高度控制虚拟滚动；此处保持自适应宽度
      return (
        <div className={styles.container}>
          <SortableWrapper>
            <div ref={tableSizeRefCallback}>
              <BaseTable
                dataSource={dataSource}
                columns={toArtColumns(columns, {
                  showIndex,
                  isRowSelect,
                  getRowKey,
                  selectedRowKeys,
                  pagination: props?.pagination,
                })}
                primaryKey={getRowKey}
                getRowProps={(record) => ({
                  'data-row-key': getRowKey(record),
                  className: classNames(
                    selectedRow.includes(record[rowKey]) ? highlightRow : '',
                    isNewRecord(record) ? styles.newRow : '',
                  ),
                  onClick: (e) => {
                    if (isPortalInBody(e.target)) return;
                    onRow?.(record)?.onClick?.(e);
                    handleRowToggle(record);
                  },
                  style: { cursor: isRowSelect || onClickRow ? 'pointer' : 'default' },
                })}
                useVirtual={false}
                style={{ width: '100%' }}
              />
            </div>
            {paginationProps ? (
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 8px', fontSize: 12 }}>
                <div>
                  第 {paginationProps.current || 1} /
                  {Math.max(
                    1,
                    Math.ceil((paginationProps.total || dataSource.length) / (paginationProps.pageSize || 20)),
                  )}{' '}
                  页，共 {paginationProps.total || dataSource.length} 条
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    disabled={(paginationProps.current || 1) <= 1}
                    onClick={() =>
                      onTableChange?.(
                        { ...paginationProps, current: (paginationProps.current || 1) - 1 },
                        {},
                        {},
                        { action: 'paginate' },
                      )
                    }
                  >
                    上一页
                  </button>
                  <button
                    disabled={
                      (paginationProps.current || 1) >=
                      Math.ceil((paginationProps.total || dataSource.length) / (paginationProps.pageSize || 20))
                    }
                    onClick={() =>
                      onTableChange?.(
                        { ...paginationProps, current: (paginationProps.current || 1) + 1 },
                        {},
                        {},
                        { action: 'paginate' },
                      )
                    }
                  >
                    下一页
                  </button>
                </div>
              </div>
            ) : null}
            {footerNode ? (
              <div className={classNames('ant-table-footer')} style={{ padding: 0 }}>
                {footerNode}
              </div>
            ) : null}
          </SortableWrapper>
          {field.errors.length > 0 && (
            <div className="ant-formily-item-error-help ant-formily-item-help ant-formily-item-help-enter ant-formily-item-help-enter-active">
              {field.errors.map((error) => {
                return error.messages.map((message) => <div key={message}>{message}</div>);
              })}
            </div>
          )}
        </div>
      );
    },
  ),
  { displayName: 'Table' },
);

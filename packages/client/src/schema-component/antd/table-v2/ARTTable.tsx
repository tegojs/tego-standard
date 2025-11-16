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
import { Table as AntdTable, TableColumnProps } from 'antd';
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

export const useArrayField = (props) => {
  const field = useField<ArrayField>();
  return (props.field || field) as ArrayField;
};

/**
 * 单元格渲染器：包裹必要的 Provider，但通过 React.memo + 依赖签名避免旧行反复渲染
 */
const getDepsSig = (fields: string[] | undefined, record: any) => {
  if (!fields || fields.length === 0) return '';
  try {
    return JSON.stringify(fields.map((n) => record?.[n]));
  } catch {
    return String(fields.length);
  }
};

type CellRendererProps = {
  s: Schema;
  depFields: string[];
  record: any;
  index: number;
  basePath: any;
  collection: any;
  parentRecordData: any;
  toolbarClass: string;
  t: (k: string, v?: any) => string;
};
const CellRenderer = React.memo(
  (props: CellRendererProps) => {
    const { s, depFields, record, index, basePath, collection, parentRecordData, toolbarClass, t } = props;
    return (
      <DeclareVariable name="$nPopupRecord" title={t('Current popup record')} value={record} collection={collection}>
        <SubFormProvider value={{ value: record, collection }}>
          <RecordIndexProvider index={record.__index || index}>
            <RecordProvider isNew={isNewRecord(record)} record={record} parent={parentRecordData}>
              <ColumnFieldProvider schema={s} basePath={basePath}>
                <span role="button" className={toolbarClass}>
                  <RecursionField basePath={basePath} schema={s} onlyRenderProperties />
                </span>
              </ColumnFieldProvider>
            </RecordProvider>
          </RecordIndexProvider>
        </SubFormProvider>
      </DeclareVariable>
    );
  },
  (prev, next) => {
    if (prev.s !== next.s) return false; // 列结构变化时允许重渲
    if (prev.index !== next.index) return false;
    if (prev.record !== next.record) {
      // 记录引用变化，进一步对比依赖字段签名
      const pSig = getDepsSig(prev.depFields, prev.record);
      const nSig = getDepsSig(next.depFields, next.record);
      if (pSig !== nSig) return false;
    }
    // basePath 仅末段索引用于定位，索引一致即可
    return true;
  },
);

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

  // 列结构签名：避免 schema 引用抖动导致的重建
  const schemaSig = useMemo(() => {
    try {
      const cols: any[] = [];
      schema.reduceProperties((buf, s) => {
        if (isColumnComponent(s) && schemaInWhitelist(Object.values(s.properties || {}).pop())) {
          const collectionFields = s.reduceProperties((inner, ss) => {
            if (isCollectionFieldComponent(ss)) return inner.concat([ss]);
            return inner;
          }, []);
          const dataIndex = collectionFields?.length > 0 ? collectionFields[0].name : s.name;
          cols.push({
            n: s.name,
            d: dataIndex,
            s: s['x-component-props']?.sorter ? 1 : 0,
            w: s['x-component-props']?.width ?? undefined,
            f: s['x-component-props']?.fixed ?? undefined,
          });
        }
        return buf;
      }, []);
      return JSON.stringify(cols);
    } catch {
      return String(schema?.name ?? 'schema');
    }
  }, [schema, schemaInWhitelist]);

  const stableSchema = useMemo(() => schema, [schemaSig]);

  // 稳定 initializer 渲染节点
  const initializerSig = useMemo(() => {
    const name = stableSchema?.['x-initializer'] ?? '';
    const props = stableSchema?.['x-initializer-props'] ?? {};
    try {
      const keys = Object.keys(props).sort();
      const sig = keys.map((k) => `${k}:${String(props[k])}`).join('|');
      return `${name}:${sig}`;
    } catch {
      return String(name);
    }
  }, [schemaSig]);
  const initializerNode = useMemo(() => (exists ? render() : null), [exists, initializerSig]);

  // 计算/渲染阶段计时依赖 schemaSig
  // const computeStartTimeRef = useRef(0);
  // useEffect(() => {
  //   computeStartTimeRef.current = performance.now();
  //   const computeEndTime = performance.now() - computeStartTimeRef.current;
  //   console.log(`[RecordItemCount] 计算完成时间: ${computeEndTime.toFixed(2)}ms`);
  //   const domUpdateTime = performance.now();
  //   console.log(`[RecordItemCount] DOM更新完成时间2: ${(domUpdateTime - computeStartTimeRef.current).toFixed(2)}ms`);
  //   const animationFrameId = requestAnimationFrame(() => {
  //     const renderTime = performance.now();
  //     console.log(`[RecordItemCount] 渲染到页面时间2: ${(renderTime - computeStartTimeRef.current).toFixed(2)}ms`);
  //   });
  //   return () => cancelAnimationFrame(animationFrameId);
  // }, [schemaSig]);

  const columns = useMemo(() => {
    return stableSchema
      .reduceProperties((buf, s) => {
        if (isColumnComponent(s) && schemaInWhitelist(Object.values(s.properties || {}).pop())) {
          return buf.concat([s]);
        }
        return buf;
      }, [])
      ?.map((s: Schema) => {
        // 收集该列依赖的字段，用于 CellRenderer 的变更对比
        const depFields = s.reduceProperties((buf, s2) => {
          if (isCollectionFieldComponent(s2)) {
            buf.push(s2.name);
          }
          return buf;
        }, [] as string[]);
        const dataIndex = depFields?.length > 0 ? depFields[0] : (s.name as string);

        // 列头节点（稳定）
        const titleNode = <RecursionField name={s.name} schema={s} onlyRenderSelf />;

        return {
          title: titleNode,
          dataIndex,
          key: s.name,
          sorter: s['x-component-props']?.['sorter'],
          width: 200,
          ...s['x-component-props'],
          render: (v, record, __indexxx) => {
            const index = __indexxx;
            const basePath = field.address.concat(record.__index || index);
            return (
              <CellRenderer
                s={s}
                depFields={depFields}
                record={record}
                index={index}
                basePath={basePath}
                collection={collection}
                parentRecordData={parentRecordData}
                toolbarClass={styles.toolbar}
                t={t as any}
              />
            );
          },
        } as TableColumnProps<any>;
      });
  }, [schemaSig, collection, parentRecordData, field.address, t, styles.toolbar]);

  if (!exists) {
    return columns;
  }

  const tableColumns = useMemo(() => {
    console.count('[ARTTable] build tableColumns');
    return columns.concat({
      title: initializerNode,
      fixed: 'right',
      dataIndex: 'TABLE_COLUMN_INITIALIZER',
      key: 'TABLE_COLUMN_INITIALIZER',
      render: designable ? () => <span /> : null,
    });
  }, [columns, designable, initializerNode]);

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
                  spliceArrayState(field as any, { startIndex: index, deleteCount: 1 });
                  field.value.splice(index, 1);
                  field.initialValue?.splice(index, 1);
                  props.setFieldValue?.([...field.value]);
                  return field.onInput(field.value);
                });
              }}
            />
          </>
        );
      },
    });
  }

  const _tableColumns = useMemo(() => {
    return [
      ...tableColumns.filter((column) => column.fixed === 'left'),
      ...tableColumns.filter((column) => !column.fixed || (column.fixed !== 'left' && column.fixed !== 'right')),
      ...tableColumns.filter((column) => column.fixed === 'right'),
    ];
  }, [tableColumns]);

  return _tableColumns;
};

const SortableRow = React.memo(
  (props: any) => {
    const { styles } = useStyles();
    const id = props['data-row-key']?.toString();
    const { setNodeRef, isOver, active, over } = useSortable({ id });
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
  },
  (prev: any, next: any) => {
    return prev?.['data-row-key'] === next?.['data-row-key'] && prev?.className === next?.className;
  },
);

const SortHandle = (props) => {
  const { id, ...otherProps } = props;
  const { listeners } = useSortable({ id });
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
  if (pagination2 === false) return false;
  if (!pagination2 && pagination1 === false) return false;
  const result = {
    showTotal,
    showSizeChanger: true,
    pageSizeOptions,
    ...pagination1,
    ...pagination2,
  };
  return result.total ? result : false;
};

export const Table: any = withDynamicSchemaProps(
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
        ...others
      } = { ...others1, ...others2 } as any;

      const field = useArrayField(others);
      const schema = useFieldSchema();
      const columns = useTableColumns(others);
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

      const isRowSelect = rowSelection?.type !== 'none';
      const dragSort = tableDragSort || field.componentProps.dragSort || false;
      const defaultRowKeyMap = useRef(new Map());

      const columnsSig = useMemo(() => {
        try {
          return (columns || []).map((c: any) => c?.key ?? c?.dataIndex ?? '').join('|');
        } catch {
          return String((columns || []).length);
        }
      }, [columns]);

      // const computeStartTimeRef = useRef(0);
      // useEffect(() => {
      //   computeStartTimeRef.current = performance.now();
      //   const computeEndTime = performance.now() - computeStartTimeRef.current;
      //   console.log(`[RecordItemCount] 计算完成时间: ${computeEndTime.toFixed(2)}ms`);
      //   const domUpdateTime = performance.now();
      //   console.log(`[RecordItemCount] DOM更新完成时间21: ${(domUpdateTime - computeStartTimeRef.current).toFixed(2)}ms`);
      //   const animationFrameId = requestAnimationFrame(() => {
      //     const renderTime = performance.now();
      //     console.log(`[RecordItemCount] 渲染到页面时间21: ${(renderTime - computeStartTimeRef.current).toFixed(2)}ms`);
      //   });
      //   return () => cancelAnimationFrame(animationFrameId);
      // }, [columnsSig]);

      let onRow = null as any;
      let highlightRow = '';
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

      const components = useMemo(() => {
        return {
          header: {
            wrapper: (p) => (
              <DndContext>
                <thead {...p} />
              </DndContext>
            ),
            cell: (p) => <th {...p} className={cls(p.className, styles.headerCellDesigner)} />,
          },
          body: {
            wrapper: (p) => (
              <DndContext
                onDragEnd={(e) => {
                  if (!e.active || !e.over) {
                    return;
                  }
                  const fromIndex = e.active?.data.current?.sortable?.index;
                  const toIndex = e.over?.data.current?.sortable?.index;
                  const from = field.value[fromIndex] || e.active;
                  const to = field.value[toIndex] || e.over;
                  void field.move(fromIndex, toIndex);
                  onRowDragEnd({ from, to });
                }}
              >
                <tbody {...p} />
              </DndContext>
            ),
            row: (p) => <SortableRow {...p} />,
            cell: (p) => <td {...p} className={classNames(p.className, styles.bodyCell)} />,
          },
        };
      }, [field, onRowDragEnd, dragSort]);

      const defaultRowKey = (record: any) => {
        if (record.key) return record.key;
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
        }
        return (rowKey ?? defaultRowKey)(record)?.toString();
      };

      const restProps = {
        rowSelection: rowSelection
          ? {
              type: 'checkbox',
              selectedRowKeys: selectedRowKeys,
              onChange(selectedRowKeys: any[], selectedRows: any[]) {
                field.data = field.data || {};
                field.data.selectedRowKeys = selectedRowKeys;
                setSelectedRowKeys(selectedRowKeys);
                onRowSelectionChange?.(selectedRowKeys, selectedRows);
              },
              getCheckboxProps() {
                return { 'aria-label': `checkbox` };
              },
              renderCell: (checked, record, index, originNode) => {
                if (!dragSort && !showIndex) {
                  return originNode;
                }
                const current = props?.pagination?.current;
                const pageSize = props?.pagination?.pageSize || 20;
                if (current) {
                  index = index + (current - 1) * pageSize + 1;
                } else {
                  index = index + 1;
                }
                if (record.__index) {
                  index = extractIndex(record.__index);
                }
                return (
                  <div
                    role="button"
                    aria-label={`table-index-${index}`}
                    className={classNames(checked ? 'checked' : null, styles.rowSelect, {
                      [styles.rowSelectHover]: isRowSelect,
                    })}
                  >
                    <div className={classNames(checked ? 'checked' : null, styles.cellChecked)}>
                      {dragSort && <SortHandle id={getRowKey(record)} />}
                      {showIndex && <TableIndex index={index} />}
                    </div>
                    {isRowSelect && (
                      <div className={classNames('tb-origin-node', checked ? 'checked' : null, styles.cellCheckedNode)}>
                        {originNode}
                      </div>
                    )}
                  </div>
                );
              },
              ...rowSelection,
            }
          : undefined,
      };

      const SortableWrapper = useCallback(
        ({ children }) =>
          dragSort
            ? React.createElement<Omit<SortableContextProps, 'children'>>(
                SortableContext,
                { items: field.value?.map?.(getRowKey) || [] },
                children,
              )
            : React.createElement(React.Fragment, {}, children),
        [field, dragSort],
      );

      const fieldSchema = useFieldSchema();
      const fixedBlock = fieldSchema?.parent?.['x-decorator-props']?.fixedBlock;
      const { height: tableHeight, tableSizeRefCallback } = useTableSize();

      const scroll = useMemo(() => {
        return fixedBlock ? { x: 'max-content', y: tableHeight } : { x: 'max-content' };
      }, [fixedBlock, tableHeight]);

      return (
        <div className={styles.container}>
          <SortableWrapper>
            <AntdTable
              ref={tableSizeRefCallback}
              rowKey={rowKey ?? defaultRowKey}
              dataSource={dataSource}
              tableLayout={(others as any)?.tableLayout ?? 'fixed'}
              {...others}
              {...restProps}
              pagination={paginationProps}
              components={components}
              onChange={(pagination, filters, sorter, extra) => {
                onTableChange?.(pagination, filters, sorter, extra);
              }}
              onRow={onRow}
              rowClassName={(record) => (selectedRow.includes(record[rowKey]) ? highlightRow : '')}
              scroll={scroll}
              columns={columns}
              expandable={{
                onExpand: (flag, record) => {
                  const newKeys = flag
                    ? [...expandedKeys, record[collection.getPrimaryKey()]]
                    : expandedKeys.filter((i) => record[collection.getPrimaryKey()] !== i);
                  setExpandesKeys(newKeys);
                  onExpand?.(flag, record);
                },
                expandedRowKeys: expandedKeys,
              }}
            />
          </SortableWrapper>
          {field.errors.length > 0 && (
            <div className="ant-formily-item-error-help ant-formily-item-help ant-formily-item-help-enter ant-formily-item-help-enter-active">
              {field.errors.map((error) => error.messages.map((message) => <div key={message}>{message}</div>))}
            </div>
          )}
        </div>
      );
    },
  ),
  { displayName: 'Table' },
);

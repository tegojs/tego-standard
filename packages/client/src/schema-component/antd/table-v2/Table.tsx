import React, { memo, Profiler, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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

/* ================= 公共 Hook ================= */
const useArrayField = (props) => {
  const field = useField<ArrayField>();
  return (props.field || field) as ArrayField;
};

const DEFAULT_LAZY_THRESHOLD = 20;

/* ========== 通用分批激活 Hook（列 / 行 共用） ========== */
function useChunkedActivation(
  total: number,
  { initial = 4, chunk = 4, idle = 60 }: { initial?: number; chunk?: number; idle?: number } = {},
) {
  const [active, setActive] = useState(() => Math.min(total, initial));
  useEffect(() => {
    if (active >= total) return;
    let cancelled = false;
    const step = () => {
      if (cancelled) return;
      setActive((prev) => {
        if (prev >= total) return prev;
        const next = Math.min(total, prev + chunk);
        if (next < total) schedule();
        return next;
      });
    };
    const schedule = () => {
      if (typeof (window as any).requestIdleCallback === 'function') {
        (window as any).requestIdleCallback(step, { timeout: idle * 4 });
      } else {
        setTimeout(step, idle);
      }
    };
    schedule();
    return () => {
      cancelled = true;
    };
  }, [total, active, chunk, idle]);
  return active;
}

/* ========== 行分批激活 Hook（仅封装参数） ========== */
function useRowChunkActivation(
  total: number,
  { initial = 12, chunk = 30, idle = 60 }: { initial?: number; chunk?: number; idle?: number } = {},
) {
  return useChunkedActivation(total, { initial, chunk, idle });
}

/* ================== 全局 schema 缓存（避免重复 reduce） ================== */
const columnSchemaCache = new Map<string, Schema[]>();

/* ========== LazyCell （轻量延迟单元格内容）========== */
const LazyCell: React.FC<{ children: React.ReactNode; delay?: number }> = memo(({ children, delay = 0 }) => {
  const [ready, setReady] = React.useState(delay === 0);
  React.useEffect(() => {
    if (ready) return;
    const cb = () => setReady(true);
    const handle =
      typeof (window as any).requestIdleCallback === 'function'
        ? (window as any).requestIdleCallback(cb, { timeout: 120 })
        : setTimeout(cb, delay);
    return () => {
      if (typeof handle === 'number') clearTimeout(handle);
      else if (typeof (window as any).cancelIdleCallback === 'function') (window as any).cancelIdleCallback(handle);
    };
  }, [ready, delay]);
  if (!ready) return <span style={{ opacity: 0.35 }}>…</span>;
  return <>{children}</>;
});

/* ================= 行级 Provider 封装 ================= */
const RowContextProviders: React.FC<{
  record: any;
  index: number;
  collection: any;
  parentRecordData: any;
  field: ArrayField;
  children: React.ReactNode;
}> = React.memo(({ record, index, collection, parentRecordData, field, children }) => {
  const realIndex = record.__index ?? index;
  return (
    <DeclareVariable name="$nPopupRecord" title="Current popup record" value={record} collection={collection}>
      <SubFormProvider value={{ value: record, collection }}>
        <RecordIndexProvider index={realIndex}>
          <RecordProvider isNew={isNewRecord(record)} record={record} parent={parentRecordData}>
            {children}
          </RecordProvider>
        </RecordIndexProvider>
      </SubFormProvider>
    </DeclareVariable>
  );
});

/* ========== 列构建（加入列分批 + 行未激活占位）========== */
const useTableColumns = (props: {
  showDel?: boolean;
  isSubTable?: boolean;
  setFieldValue?: any;
  dataSourceOverride?: any[];
  lazyCellDelay?: number; // 单元格基础延迟（毫秒），未传则不延迟
  lazyThreshold?: number; // 行数超过阈值才启用
  colChunkInitial?: number;
  colChunkSize?: number;
  colChunkIdle?: number;
  scrolling?: boolean; // 滚动中：禁用 LazyCell，直接渲染
}) => {
  const { t } = useTranslation();
  const { styles } = useStyles();
  const field = useArrayField(props);
  const schema = useFieldSchema();
  const { schemaInWhitelist } = useACLFieldWhitelist();
  const { designable } = useDesignable();
  const { exists, render } = useSchemaInitializerRender(schema['x-initializer'], schema['x-initializer-props']);

  // 数据源
  let dataSource: any[] = [];
  if (Array.isArray(props.dataSourceOverride)) {
    dataSource = props.dataSourceOverride;
  } else {
    const raw = field?.value;
    if (Array.isArray(raw)) dataSource = raw;
    else dataSource = [];
  }

  const rowCount = dataSource.length;
  const enableLazy =
    typeof props.lazyCellDelay === 'number' &&
    rowCount >= (props.lazyThreshold ?? DEFAULT_LAZY_THRESHOLD) &&
    props.lazyCellDelay >= 0;

  const baseSchemas = useMemo(() => {
    const key = schema?.uid;
    if (key && columnSchemaCache.has(key)) return columnSchemaCache.get(key)!;
    const list = schema.reduceProperties((buf, s) => {
      if (isColumnComponent(s) && schemaInWhitelist(Object.values(s.properties || {}).pop())) {
        buf.push(s);
      }
      return buf;
    }, [] as Schema[]);
    if (key) columnSchemaCache.set(key, list);
    return list;
  }, [schema?.uid, schemaInWhitelist]);

  const columns = useMemo(
    () =>
      baseSchemas.map((s: Schema, colIdx: number) => {
        const collectionFields = s.reduceProperties((buf, cs) => {
          if (isCollectionFieldComponent(cs)) buf.push(cs);
          return buf;
        }, []);
        const dataIndex = collectionFields?.length > 0 ? collectionFields[0].name : s.name;
        const colDelay = enableLazy ? (props.lazyCellDelay || 0) + colIdx * 5 : 0;
        return {
          __colIndex: colIdx,
          title: <RecursionField name={s.name} schema={s} onlyRenderSelf />,
          dataIndex,
          key: s.name,
          sorter: s['x-component-props']?.['sorter'],
          width: 200,
          ...s['x-component-props'],
          render: (_v, record, index) => {
            const rowIndex = index;
            if (record.__inactive) {
              return (
                <span role="button" className={styles.toolbar} style={{ opacity: 0.25 }}>
                  …
                </span>
              );
            }
            return (
              <ColumnFieldProvider schema={s} basePath={field.address.concat(rowIndex)}>
                <span role="button" className={styles.toolbar}>
                  <LazyCell delay={colDelay}>
                    <RecursionField basePath={field.address.concat(rowIndex)} schema={s} onlyRenderProperties />
                  </LazyCell>
                </span>
              </ColumnFieldProvider>
            );
          },
        } as TableColumnProps<any> & { __colIndex: number };
      }),
    [baseSchemas, enableLazy, props.lazyCellDelay, field.address, field.value, styles.toolbar],
  );

  // 列分批激活
  const activeCols = useChunkedActivation(columns.length, {
    initial: props.colChunkInitial ?? 4,
    chunk: props.colChunkSize ?? 4,
    idle: props.colChunkIdle ?? 60,
  });

  const progressiveColumns = useMemo(() => {
    if (activeCols >= columns.length) return columns;
    return columns.map((c: any, i) => {
      if (i < activeCols) return c;
      return {
        ...c,
        render: () => (
          <span role="button" className={styles.toolbar} style={{ opacity: 0.2 }}>
            …
          </span>
        ),
      };
    });
  }, [columns, activeCols, styles.toolbar]);

  const effectiveColumns = progressiveColumns;

  if (!exists) return effectiveColumns;

  const tableColumns = effectiveColumns.concat({
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
      render: (_v, record, index) => {
        return (
          <>
            <CopyOutlined
              style={{ cursor: 'pointer', marginRight: 10 }}
              onClick={() => {
                action(() => {
                  if (!Array.isArray(field.value)) field.value = [];
                  spliceArrayState(field as any, {
                    startIndex: index + 1,
                    insertCount: 1,
                  });
                  field.value.splice(index + 1, 0, markRecordAsNew(_.cloneDeep(record)));
                  each(field.form.fields, (targetField, key) => {
                    if (!targetField) delete field.form.fields[key];
                  });
                  field.onInput(field.value);
                });
              }}
            />
            <DeleteOutlined
              style={{ cursor: 'pointer' }}
              onClick={() => {
                action(() => {
                  const idx = field.value.indexOf(record);
                  spliceArrayState(field as any, {
                    startIndex: idx,
                    deleteCount: 1,
                  });
                  field.value.splice(idx, 1);
                  field.initialValue?.splice?.(idx, 1);
                  props.setFieldValue?.([...field.value]);
                  field.onInput(field.value);
                });
              }}
            />
          </>
        );
      },
    } as any);
  }

  return [
    ...tableColumns.filter((column) => column.fixed === 'left'),
    ...tableColumns.filter((column) => !column.fixed || (column.fixed !== 'left' && column.fixed !== 'right')),
    ...tableColumns.filter((column) => column.fixed === 'right'),
  ];
};

/* ========== Sortable 行/索引/拖拽 ========== */
const SortableRow = (props) => {
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
};

const SortHandle = (props) => {
  const { id, ...otherProps } = props;
  const { listeners } = useSortable({ id });
  return <MenuOutlined {...otherProps} {...listeners} style={{ cursor: 'grab' }} />;
};

const TableIndex = ({ index, ...otherProps }) => (
  <div className={classNames('tb-table-index')} style={{ padding: '0 8px 0 16px' }} {...otherProps}>
    {index}
  </div>
);

/* ========== 分页 props ========== */
const pageSizeOptions = [5, 10, 20, 50, 100, 200];
const usePaginationProps = (pagination1, pagination2) => {
  const { t } = useTranslation();
  const showTotal = useCallback((total) => t('Total {{count}} items', { count: total }), [t]);
  const result = {
    showTotal,
    showSizeChanger: true,
    pageSizeOptions,
    ...pagination1,
    ...pagination2,
  };
  return result.total ? result : pagination1 || pagination2;
};

/* ========== 主组件 ========== */
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
      lazyCellDelay?: number;
      lazyThreshold?: number;
      // 列分批
      colChunkInitial?: number;
      colChunkSize?: number;
      colChunkIdle?: number;
      // 行分批
      rowChunkInitial?: number;
      rowChunkSize?: number;
      rowChunkIdle?: number;
    }) => {
      const { token } = useToken();
      const { styles } = useStyles();
      const { pagination: pagination1, useProps, ...others1 } = props;
      const { pagination: pagination2, ...others2 } = useProps?.() || {};

      const {
        dragSort = false,
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
      const columns = useTableColumns({
        ...others,
        lazyCellDelay: others.lazyCellDelay,
        lazyThreshold: others.lazyThreshold,
        dataSourceOverride: others.dataSourceOverride,
        colChunkInitial: others.colChunkInitial,
        colChunkSize: others.colChunkSize,
        colChunkIdle: others.colChunkIdle,
      });
      const schema = useFieldSchema();
      const collection = useCollection_deprecated();
      const isTableSelector = schema?.parent?.['x-decorator'] === 'TableSelectorProvider';
      const ctx = isTableSelector ? useTableSelectorContext() : useTableBlockContext();
      const { expandFlag, allIncludesChildren } = ctx;
      const onRowDragEnd = useMemoizedFn(others.onRowDragEnd || (() => {}));
      const paginationProps = usePaginationProps(pagination1, pagination2);

      const [expandedKeys, setExpandesKeys] = useState<any[]>([]);
      const [selectedRowKeys, setSelectedRowKeys] = useState<any[]>(field?.data?.selectedRowKeys || []);
      const [selectedRow, setSelectedRow] = useState<any[]>([]);

      const dataSource = field?.value?.slice?.()?.filter?.(Boolean) || [];

      // 行分批激活：仅前 rowActiveLimit 行包 Provider
      const rowActiveLimit = useRowChunkActivation(dataSource.length, {
        initial: others.rowChunkInitial ?? 12,
        chunk: others.rowChunkSize ?? 30,
        idle: others.rowChunkIdle ?? 60,
      });

      const isRowSelect = rowSelection?.type !== 'none';
      const defaultRowKeyMap = useRef(new Map());

      let onRow: any = null;
      let highlightRow = '';
      if (onClickRow) {
        onRow = (record) => ({
          onClick: (e) => {
            if (isPortalInBody(e.target)) return;
            onClickRow(record, setSelectedRow, selectedRow);
          },
        });
        highlightRow = styles.highlightRow;
      }

      useEffect(() => {
        if (expandFlag) setExpandesKeys(allIncludesChildren);
        else setExpandesKeys([]);
      }, [expandFlag, allIncludesChildren]);

      const collectionRuntime = useCollection();
      const parentRecordData = useCollectionParentRecordData();

      const components = useMemo(() => {
        return {
          header: {
            wrapper: (p) =>
              dragSort ? (
                <DndContext>
                  <thead {...p} />
                </DndContext>
              ) : (
                <thead {...p} />
              ),
            cell: (p) => <th {...p} className={cls(p.className, styles.headerCellDesigner)} />,
          },
          body: {
            wrapper: (p) =>
              dragSort ? (
                <DndContext
                  onDragEnd={(e) => {
                    if (!e.active || !e.over) return;
                    const fromIndex = e.active?.data.current?.sortable?.index;
                    const toIndex = e.over?.data.current?.sortable?.index;
                    const from = field.value[fromIndex] || e.active;
                    const to = field.value[toIndex] || e.over;
                    field.move?.(fromIndex, toIndex);
                    onRowDragEnd({ from, to });
                  }}
                >
                  <tbody {...p} />
                </DndContext>
              ) : (
                <tbody {...p} />
              ),
            row: (rowProps) => {
              const { record } = rowProps;
              if (!record) return <SortableRow {...rowProps} />;
              const rIdx =
                record.__rIndex ??
                record.__index ??
                (typeof rowProps['data-row-index'] === 'number' ? rowProps['data-row-index'] : 0);
              if (rIdx >= rowActiveLimit) {
                record.__inactive = true;
                return <SortableRow {...rowProps} />;
              }
              if (record.__inactive) delete record.__inactive;
              return (
                <RowContextProviders
                  record={record}
                  index={rIdx}
                  collection={collectionRuntime}
                  parentRecordData={parentRecordData}
                  field={field}
                >
                  <SortableRow {...rowProps} />
                </RowContextProviders>
              );
            },
            cell: (p) => <td {...p} className={classNames(p.className, styles.bodyCell)} />,
          },
        };
      }, [
        field,
        onRowDragEnd,
        dragSort,
        collectionRuntime,
        parentRecordData,
        styles.bodyCell,
        styles.headerCellDesigner,
        rowActiveLimit,
      ]);

      const defaultRowKey = (record: any) => {
        if (record.key) return record.key;
        if (defaultRowKeyMap.current.has(record)) return defaultRowKeyMap.current.get(record);
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
              selectedRowKeys,
              onChange(selectedRowKeys: any[], selectedRows: any[]) {
                field.data = field.data || {};
                field.data.selectedRowKeys = selectedRowKeys;
                setSelectedRowKeys(selectedRowKeys);
                onRowSelectionChange?.(selectedRowKeys, selectedRows);
              },
              getCheckboxProps() {
                return { 'aria-label': 'checkbox' };
              },
              renderCell: (checked, record, index, originNode) => {
                if (!dragSort && !showIndex) return originNode;
                const current = props?.pagination?.current;
                const pageSize = props?.pagination?.pageSize || 20;
                if (current) {
                  index = index + (current - 1) * pageSize + 1;
                } else {
                  index = index + 1;
                }
                if (record.__index) index = extractIndex(record.__index);
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
      const scroll = useMemo(
        () => (fixedBlock ? { x: 'max-content', y: tableHeight } : { x: 'max-content' }),
        [fixedBlock, tableHeight],
      );

      // 签名 & 数据变化监听
      const buildArraySig = (arr: any[]) => {
        if (!Array.isArray(arr) || !arr.length) return '0';
        const f = arr[0];
        const l = arr[arr.length - 1];
        return `${arr.length}:${f?.id || f?.key || f?._id || ''}:${l?.id || l?.key || l?._id || ''}`;
      };
      const rawDS = (() => {
        const v = field?.value;
        if (Array.isArray(v)) return v;
        return [];
      })();
      const arraySig = useMemo(() => buildArraySig(rawDS), [rawDS]);

      // 预写 __rIndex
      useLayoutEffect(() => {
        for (let i = 0; i < dataSource.length; i++) {
          const r = dataSource[i];
          if (r && r.__rIndex !== i) r.__rIndex = i;
        }
      }, [dataSource]);

      if (others.lazyCellDelay == null) {
        if (dataSource.length > 15) {
          others.lazyCellDelay = 10;
          others.lazyThreshold = 0;
        }
      }

      const dataChangeSig = arraySig;
      const deepSig = '';

      useEffect(() => {
        props?.onDataChange?.(rawDS, { arraySig, deepSig });
      }, [dataChangeSig]);

      const onProfilerRender = useCallback(
        (
          _id: string,
          phase: 'mount' | 'update',
          actualDuration: number,
          baseDuration: number,
          startTime: number,
          commitTime: number,
        ) => {
          if (actualDuration > 5)
            console.log('[TableProfiler]', {
              phase,
              actual: +actualDuration.toFixed(2),
              base: +baseDuration.toFixed(2),
              start: +startTime.toFixed(1),
              commit: +commitTime.toFixed(1),
              rows: rawDS.length,
              cols: columns?.length || 0,
            });
        },
        [rawDS.length, columns?.length],
      );

      // 虚拟滚动
      const virtualEnabled = others.virtual && typeof others.virtualRowHeight === 'number';
      const rowHeight = others.virtualRowHeight || 42;
      const overscan = others.virtualOverscan ?? 4;
      const scrollContainerRef = useRef<HTMLDivElement | null>(null);
      const [virtualRange, setVirtualRange] = useState({
        start: 0,
        end: dataSource.length - 1,
      });
      useEffect(() => {
        if (!virtualEnabled) return;
        const el = scrollContainerRef.current?.querySelector('.ant-table-body');
        if (!el) return;
        const onScroll = () => {
          const scrollTop = (el as HTMLElement).scrollTop;
          const visibleCount = Math.ceil(((el as HTMLElement).clientHeight || 400) / rowHeight);
          const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
          const end = Math.min(dataSource.length - 1, start + visibleCount + overscan * 2);
          setVirtualRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
        };
        onScroll();
        el.addEventListener('scroll', onScroll);
        return () => el.removeEventListener('scroll', onScroll);
      }, [virtualEnabled, dataSource.length, rowHeight, overscan]);

      const visualData = useMemo(() => {
        if (!virtualEnabled) return dataSource;
        return dataSource.slice(virtualRange.start, virtualRange.end + 1);
      }, [dataSource, virtualEnabled, virtualRange]);

      const virtualOffsetStyle = virtualEnabled
        ? {
            paddingTop: virtualRange.start * rowHeight,
            paddingBottom: (dataSource.length - virtualRange.end - 1) * rowHeight,
          }
        : undefined;

      return (
        <Profiler id="Table" onRender={onProfilerRender}>
          <div className={styles.container} ref={scrollContainerRef}>
            <SortableWrapper>
              <AntdTable
                ref={tableSizeRefCallback}
                rowKey={rowKey ?? defaultRowKey}
                dataSource={visualData}
                tableLayout="auto"
                {...others}
                {...restProps}
                pagination={!!paginationProps}
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
                components={
                  virtualEnabled
                    ? {
                        ...components,
                        body: {
                          ...components.body,
                          wrapper: (p) => <div style={virtualOffsetStyle}>{components.body.wrapper(p)}</div>,
                        },
                      }
                    : components
                }
              />
            </SortableWrapper>
            {(() => {
              const errsRaw = field?.errors;
              const errs = Array.isArray(errsRaw) ? errsRaw : errsRaw ? [errsRaw] : [];
              if (!errs.length) return null;
              return (
                <div className="ant-formily-item-error-help ant-formily-item-help ant-formily-item-help-enter ant-formily-item-help-enter-active">
                  {errs.flatMap((e, i) =>
                    Array.isArray(e?.messages)
                      ? e.messages.map((m, j) => <div key={`${i}-${j}-${m}`}>{m}</div>)
                      : e
                        ? [<div key={`single-${i}`}>{String(e)}</div>]
                        : [],
                  )}
                </div>
              );
            })()}
          </div>
        </Profiler>
      );
    },
  ),
  { displayName: 'Table' },
);

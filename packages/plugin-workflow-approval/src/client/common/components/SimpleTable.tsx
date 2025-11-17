import React from 'react';

import { useTranslation } from '../../locale';

export interface SimpleTableColumn {
  key: string;
  title: string;
  dataIndex?: string;
  render?: (value: any, record: any, index: number) => React.ReactNode;
}

export interface SimpleTableProps {
  /** 表格标题 */
  title?: React.ReactNode;
  /** 表格列配置 */
  columns: SimpleTableColumn[];
  /** 表格数据源 */
  dataSource: any[];
  /** 自定义样式 */
  style?: React.CSSProperties;
  /** 表格容器样式 */
  wrapperStyle?: React.CSSProperties;
}

/**
 * 极简表格组件
 * 用于展示简单的表格数据，样式简洁，无额外依赖
 */
export const SimpleTable: React.FC<SimpleTableProps> = ({ title, columns, dataSource, style, wrapperStyle }) => {
  const { t } = useTranslation();
  return (
    <div style={{ marginBottom: 12, maxWidth: '100%', ...wrapperStyle }}>
      <table
        style={{
          width: '100%',
          maxWidth: '100%',
          borderCollapse: 'collapse',
          fontSize: 12,
          tableLayout: 'fixed',
          ...style,
        }}
      >
        <thead
          style={{
            backgroundColor: '#f5f5f5',
            fontWeight: 'normal',
            color: '#666',
          }}
        >
          {title && (
            <tr>
              <th
                colSpan={columns.length}
                style={{
                  padding: '4px 8px',
                  textAlign: 'center',
                  border: '1px solid #e8e8e8',
                  backgroundColor: '#f5f5f5',
                  fontWeight: 'bold',
                  color: '#333',
                }}
              >
                {title}
              </th>
            </tr>
          )}
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                style={{
                  padding: '4px 8px',
                  textAlign: 'center',
                  border: '1px solid #e8e8e8',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {column.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dataSource.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                style={{
                  padding: '8px',
                  textAlign: 'center',
                  border: '1px solid #e8e8e8',
                  color: '#999',
                }}
              >
                {t('No data yet')}
              </td>
            </tr>
          ) : (
            dataSource.map((record, rowIdx) => (
              <tr key={rowIdx}>
                {columns.map((column) => {
                  const value = column.dataIndex ? record[column.dataIndex] : record[column.key];
                  const cellValue = column.render ? column.render(value, record, rowIdx) : (value ?? '');

                  return (
                    <td
                      key={column.key}
                      style={{
                        padding: '4px 8px',
                        border: '1px solid #e8e8e8',
                        color: '#333',
                        textAlign: 'center',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={typeof cellValue === 'string' ? cellValue : String(cellValue ?? '')}
                    >
                      {cellValue}
                    </td>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
};

import { useCallback, useEffect, useMemo, useState } from 'react';
import { DatePicker, useAPIClient } from '@tachybase/client';

import { DeleteOutlined, DownloadOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, message, Modal, Space, Spin, Table } from 'antd';
import dayjs from 'dayjs';
import { saveAs } from 'file-saver';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

import { useTranslation } from '../locale';

interface TableInfo {
  name: string;
  origin: string;
  size: number;
  rowCount: number;
  createdAt: Date | null;
  updatedAt: Date | null;
  hasCreatedAt: boolean;
  hasUpdatedAt: boolean;
}

interface FilterState {
  createdAt?: [dayjs.Dayjs | null, dayjs.Dayjs | null];
  updatedAt?: [dayjs.Dayjs | null, dayjs.Dayjs | null];
}

export const TableDetail = () => {
  const { t } = useTranslation();
  const apiClient = useAPIClient();
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  // 从路径中提取表名，路径格式：/admin/settings/system-services/database-clean/:tableName
  const tableName = params.tableName || location.pathname.split('/').pop();
  const { modal, notification } = App.useApp();

  const [tableInfo, setTableInfo] = useState<TableInfo | null>(null);
  const [dataSource, setDataSource] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [backupLoading, setBackupLoading] = useState(false);
  const [cleanLoading, setCleanLoading] = useState(false);
  const [backupFileName, setBackupFileName] = useState<string | null>(null);
  const [hasBackedUp, setHasBackedUp] = useState(false);
  const [pagination, setPagination] = useState({
    current: 1,
    pageSize: 20,
    total: 0,
  });

  const [filter, setFilter] = useState<FilterState>({});

  const resource = useMemo(() => {
    return apiClient.resource('databaseClean');
  }, [apiClient]);

  useEffect(() => {
    if (tableName) {
      loadTableInfo();
      loadTableData();
    }
  }, [tableName]);

  useEffect(() => {
    if (tableName) {
      loadTableData();
    }
  }, [pagination.current, pagination.pageSize, filter]);

  const loadTableInfo = async () => {
    if (!tableName) return;
    try {
      const response = await resource.get({ filterByTk: tableName });
      // Axios 响应格式: response.data = { data: {...} }
      setTableInfo(response.data?.data);
    } catch (error) {
      message.error(error.message || t('Failed to load table info'));
      navigate('/_admin/system-services/database-clean');
    }
  };

  const loadTableData = async () => {
    if (!tableName) return;
    setLoading(true);
    try {
      // 构建筛选条件
      const filterParams: any = {};
      if (filter.createdAt && filter.createdAt[0] && filter.createdAt[1]) {
        filterParams.createdAt = {
          $gte: filter.createdAt[0].startOf('day').toISOString(),
          $lte: filter.createdAt[1].endOf('day').toISOString(),
        };
      }
      if (filter.updatedAt && filter.updatedAt[0] && filter.updatedAt[1]) {
        filterParams.updatedAt = {
          $gte: filter.updatedAt[0].startOf('day').toISOString(),
          $lte: filter.updatedAt[1].endOf('day').toISOString(),
        };
      }

      const response = await resource.data({
        filterByTk: tableName,
        page: pagination.current,
        pageSize: pagination.pageSize,
        filter: Object.keys(filterParams).length > 0 ? filterParams : undefined,
      });

      // Axios 响应格式: response.data = { data: [...], meta: {...} }
      const { data: rows, meta } = response.data;
      setDataSource(Array.isArray(rows) ? rows : []);
      setPagination((prev) => ({
        ...prev,
        total: meta?.count || 0,
      }));
    } catch (error) {
      message.error(error.message || t('Failed to load table data'));
    } finally {
      setLoading(false);
    }
  };

  const handleBackup = async () => {
    if (!tableName) return;
    setBackupLoading(true);
    try {
      // 构建筛选条件
      const filterParams: any = {};
      if (filter.createdAt && filter.createdAt[0] && filter.createdAt[1]) {
        filterParams.createdAt = {
          $gte: filter.createdAt[0].startOf('day').toISOString(),
          $lte: filter.createdAt[1].endOf('day').toISOString(),
        };
      }
      if (filter.updatedAt && filter.updatedAt[0] && filter.updatedAt[1]) {
        filterParams.updatedAt = {
          $gte: filter.updatedAt[0].startOf('day').toISOString(),
          $lte: filter.updatedAt[1].endOf('day').toISOString(),
        };
      }

      const response = await resource.backup({
        values: {
          collectionName: tableName,
          filter: Object.keys(filterParams).length > 0 ? filterParams : undefined,
        },
      });

      // Axios 响应格式: response.data = { data: {...} }
      setBackupFileName(response.data?.data?.fileName);
      setHasBackedUp(true);
      message.success(t('Backup Success'));
    } catch (error) {
      message.error(error.message || t('Backup Failed'));
    } finally {
      setBackupLoading(false);
    }
  };

  const handleDownload = async () => {
    if (!backupFileName) return;
    try {
      const data = await apiClient.request({
        url: 'databaseClean:download',
        method: 'get',
        params: {
          filterByTk: backupFileName,
        },
        responseType: 'blob',
      });
      const blob = new Blob([data.data]);
      saveAs(blob, backupFileName);
      message.success(t('Download') + ' ' + t('Success'));
    } catch (error) {
      message.error(error.message || t('Download') + ' ' + t('Failed'));
    }
  };

  const handleClean = () => {
    if (!hasBackedUp) {
      message.warning(t('Please backup first'));
      return;
    }

    modal.confirm({
      title: t('Confirm Clean'),
      content: (
        <div>
          <p>{t('Are you sure you want to clean the filtered data?')}</p>
          <p style={{ color: 'red' }}>{t('This action cannot be undone')}</p>
        </div>
      ),
      okText: t('Clean'),
      okButtonProps: { danger: true },
      onOk: async () => {
        await doClean();
      },
    });
  };

  const doClean = async () => {
    if (!tableName) return;
    setCleanLoading(true);
    try {
      // 构建筛选条件
      const filterParams: any = {};
      if (filter.createdAt && filter.createdAt[0] && filter.createdAt[1]) {
        filterParams.createdAt = {
          $gte: filter.createdAt[0].startOf('day').toISOString(),
          $lte: filter.createdAt[1].endOf('day').toISOString(),
        };
      }
      if (filter.updatedAt && filter.updatedAt[0] && filter.updatedAt[1]) {
        filterParams.updatedAt = {
          $gte: filter.updatedAt[0].startOf('day').toISOString(),
          $lte: filter.updatedAt[1].endOf('day').toISOString(),
        };
      }

      const response = await resource.clean({
        values: {
          collectionName: tableName,
          filter: Object.keys(filterParams).length > 0 ? filterParams : undefined,
        },
      });

      // Axios 响应格式: response.data = { data: {...} }
      message.success(t('Clean Success') + ` (${response.data?.data?.deletedCount} ${t('records deleted')})`);
      setHasBackedUp(false);
      setBackupFileName(null);
      await loadTableData();
      await loadTableInfo();
    } catch (error) {
      message.error(error.message || t('Clean Failed'));
    } finally {
      setCleanLoading(false);
    }
  };

  const handleTableChange = (newPagination: any) => {
    setPagination((prev) => ({
      ...prev,
      current: newPagination.current,
      pageSize: newPagination.pageSize,
    }));
  };

  // 构建表格列
  const columns = useMemo(() => {
    if (!dataSource.length) return [];
    const firstRow = dataSource[0];
    return Object.keys(firstRow).map((key) => ({
      title: key,
      dataIndex: key,
      key,
      render: (value: any) => {
        if (value instanceof Date || (typeof value === 'string' && value.match(/^\d{4}-\d{2}-\d{2}/))) {
          return <DatePicker.ReadPretty value={dayjs(value)} showTime />;
        }
        if (typeof value === 'object' && value !== null) {
          return <pre style={{ margin: 0 }}>{JSON.stringify(value, null, 2)}</pre>;
        }
        return String(value);
      },
    }));
  }, [dataSource]);

  if (!tableInfo) {
    return (
      <div style={{ textAlign: 'center', padding: 50 }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div>
      <Card bordered={false}>
        <Space direction="vertical" style={{ width: '100%' }} size="large">
          {/* 表信息 */}
          <div>
            <h2>{tableInfo.name}</h2>
            <Space>
              <span>
                {t('Origin')}: {tableInfo.origin}
              </span>
              <span>|</span>
              <span>
                {t('Size')}: {formatFileSize(tableInfo.size)}
              </span>
              <span>|</span>
              <span>
                {t('Row Count')}: {tableInfo.rowCount.toLocaleString()}
              </span>
            </Space>
          </div>

          {/* 筛选面板 */}
          <Card size="small" title={t('Filter')}>
            <Space direction="vertical" style={{ width: '100%' }}>
              {!tableInfo.hasCreatedAt && !tableInfo.hasUpdatedAt && (
                <Alert message={t('No time fields')} type="warning" showIcon />
              )}
              {tableInfo.hasCreatedAt && (
                <div>
                  <label>{t('Created At Range')}: </label>
                  <DatePicker.RangePicker
                    value={filter.createdAt}
                    onChange={(dates) => {
                      setFilter((prev) => ({
                        ...prev,
                        createdAt: dates as [dayjs.Dayjs | null, dayjs.Dayjs | null],
                      }));
                    }}
                    showTime
                    style={{ width: 400 }}
                  />
                </div>
              )}
              {tableInfo.hasUpdatedAt && (
                <div>
                  <label>{t('Updated At Range')}: </label>
                  <DatePicker.RangePicker
                    value={filter.updatedAt}
                    onChange={(dates) => {
                      setFilter((prev) => ({
                        ...prev,
                        updatedAt: dates as [dayjs.Dayjs | null, dayjs.Dayjs | null],
                      }));
                    }}
                    showTime
                    style={{ width: 400 }}
                  />
                </div>
              )}
            </Space>
          </Card>

          {/* 操作按钮 */}
          <Space>
            <Button onClick={loadTableData} icon={<ReloadOutlined />}>
              {t('Refresh')}
            </Button>
            <Button type="primary" icon={<SaveOutlined />} loading={backupLoading} onClick={handleBackup}>
              {t('Backup')}
            </Button>
            {backupFileName && (
              <Button icon={<DownloadOutlined />} onClick={handleDownload}>
                {t('Download')}
              </Button>
            )}
            <Button
              danger
              icon={<DeleteOutlined />}
              loading={cleanLoading}
              onClick={handleClean}
              disabled={!hasBackedUp}
            >
              {t('Clean')}
            </Button>
          </Space>

          {/* 数据表格 */}
          <Table
            dataSource={dataSource}
            loading={loading}
            columns={columns}
            rowKey={(record, index) => record.id || index}
            pagination={{
              ...pagination,
              showSizeChanger: true,
              showTotal: (total) => t('Total: {{total}}', { total }),
            }}
            onChange={handleTableChange}
            scroll={{ x: 'max-content' }}
          />
        </Space>
      </Card>
    </div>
  );
};

/**
 * 格式化文件大小
 */
function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

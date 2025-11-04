import { useCallback, useEffect, useMemo, useState } from 'react';
import { DatePicker, useAPIClient } from '@tachybase/client';

import { ReloadOutlined } from '@ant-design/icons';
import { App, Button, Card, message, Space, Table } from 'antd';
import dayjs from 'dayjs';
import { useNavigate } from 'react-router-dom';

import { useTranslation } from '../locale';

interface TableInfo {
  name: string;
  origin: string;
  size: number;
  rowCount: number;
  createdAt: Date | null;
  updatedAt: Date | null;
}

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

export const TableList = () => {
  const { t } = useTranslation();
  const apiClient = useAPIClient();
  const navigate = useNavigate();
  const [dataSource, setDataSource] = useState<TableInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [pagination, setPagination] = useState({
    current: 1,
    pageSize: 20,
    total: 0,
  });

  const resource = useMemo(() => {
    return apiClient.resource('databaseClean');
  }, [apiClient]);

  const handleRefresh = useCallback(async () => {
    await queryTableList();
  }, []);

  useEffect(() => {
    queryTableList();
  }, [pagination.current, pagination.pageSize]);

  const queryTableList = async () => {
    setLoading(true);
    try {
      const { data } = await resource.list({
        params: {
          page: pagination.current,
          pageSize: pagination.pageSize,
        },
      });
      setDataSource(data.rows || []);
      setPagination((prev) => ({
        ...prev,
        total: data.count || 0,
      }));
    } catch (error) {
      message.error(error.message || t('Failed to load table list'));
    } finally {
      setLoading(false);
    }
  };

  const handleTableChange = (newPagination: any) => {
    setPagination((prev) => ({
      ...prev,
      current: newPagination.current,
      pageSize: newPagination.pageSize,
    }));
  };

  const columns = [
    {
      title: t('Table Name'),
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => (
        <a
          onClick={() => {
            navigate(`/_admin/system-services/database-clean/${name}`);
          }}
        >
          {name}
        </a>
      ),
    },
    {
      title: t('Origin'),
      dataIndex: 'origin',
      key: 'origin',
    },
    {
      title: t('Size'),
      dataIndex: 'size',
      key: 'size',
      render: (size: number) => formatFileSize(size),
    },
    {
      title: t('Row Count'),
      dataIndex: 'rowCount',
      key: 'rowCount',
      render: (count: number) => count.toLocaleString(),
    },
    {
      title: t('Created At'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (value: Date | null) => (value ? <DatePicker.ReadPretty value={dayjs(value)} showTime /> : '-'),
    },
    {
      title: t('Updated At'),
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      render: (value: Date | null) => (value ? <DatePicker.ReadPretty value={dayjs(value)} showTime /> : '-'),
    },
  ];

  return (
    <div>
      <Card bordered={false}>
        <Space style={{ float: 'right', marginBottom: 16 }}>
          <Button onClick={handleRefresh} icon={<ReloadOutlined />}>
            {t('Refresh')}
          </Button>
        </Space>
        <Table<TableInfo>
          dataSource={dataSource}
          loading={loading}
          columns={columns}
          rowKey="name"
          pagination={{
            ...pagination,
            showSizeChanger: true,
            showTotal: (total) => t('Total: {{total}}', { total }),
          }}
          onChange={handleTableChange}
        />
      </Card>
    </div>
  );
};

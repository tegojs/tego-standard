import React, { useState } from 'react';
import { useAPIClient, useRequest } from '@tachybase/client';

import { FileTextOutlined } from '@ant-design/icons';
import { Button, Card, Form, Input, message, Select, Space, Table } from 'antd';
import { saveAs } from 'file-saver';

import { useTranslation } from './locale';

const { TextArea } = Input;
const { Option } = Select;

export const ReportGeneratorSettings: React.FC = () => {
  const api = useAPIClient();
  const { t } = useTranslation();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [collections, setCollections] = useState<any[]>([]);
  const [selectedCollection, setSelectedCollection] = useState<string>('');
  const [collectionFields, setCollectionFields] = useState<any[]>([]);

  // 获取数据集合列表
  const { data: collectionsData, loading: collectionsLoading } = useRequest({
    resource: 'reportGenerator',
    action: 'listCollections',
  });

  React.useEffect(() => {
    if (collectionsData?.data) {
      setCollections(collectionsData.data);
    }
  }, [collectionsData]);

  // 当选择集合时，更新字段列表
  React.useEffect(() => {
    if (selectedCollection && collections.length > 0) {
      const collection = collections.find((c) => c.name === selectedCollection);
      if (collection) {
        setCollectionFields(collection.fields || []);
      }
    }
  }, [selectedCollection, collections]);

  const handleGenerate = async (values: any) => {
    if (!values.prompt) {
      message.error(t('Please enter a prompt'));
      return;
    }

    setLoading(true);
    try {
      const response = await api.request({
        url: 'reportGenerator:generate',
        method: 'post',
        data: {
          prompt: values.prompt,
          collectionName: values.collectionName || undefined,
          format: 'xlsx',
        },
        responseType: 'blob',
      });

      if (response.data) {
        // 响应直接包含文件内容
        const blob = new Blob([response.data], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
        const filename = `report_${new Date().getTime()}.xlsx`;
        saveAs(blob, filename);

        message.success(t('Report generated successfully'));
      } else {
        message.error(t('Failed to generate report'));
      }
    } catch (error: any) {
      console.error('Generate report error:', error);
      message.error(error?.response?.data?.message || t('Failed to generate report'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card title={t('Report Generator')} style={{ margin: '20px' }}>
      <Form form={form} layout="vertical" onFinish={handleGenerate}>
        <Form.Item
          label={t('Data Collection')}
          name="collectionName"
          tooltip={t('Select a data collection, or leave empty to auto-detect from prompt')}
        >
          <Select
            placeholder={t('Select or leave empty for auto-detection')}
            allowClear
            loading={collectionsLoading}
            onChange={(value) => setSelectedCollection(value)}
          >
            {collections.map((collection) => (
              <Option key={collection.name} value={collection.name}>
                {collection.title || collection.name}
              </Option>
            ))}
          </Select>
        </Form.Item>

        <Form.Item
          label={t('Prompt')}
          name="prompt"
          rules={[{ required: true, message: t('Please enter a prompt') }]}
          tooltip={t('Describe what kind of report you want to generate, e.g., "Generate a user list report"')}
        >
          <TextArea
            rows={4}
            placeholder={t(
              'Example: Generate a user list report, or Generate a report of all orders in the last month',
            )}
          />
        </Form.Item>

        <Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" icon={<FileTextOutlined />} loading={loading}>
              {t('Generate Report')}
            </Button>
          </Space>
        </Form.Item>
      </Form>

      {selectedCollection && collectionFields.length > 0 && (
        <Card title={t('Available Fields')} size="small" style={{ marginTop: '20px' }}>
          <Table
            dataSource={collectionFields}
            rowKey="name"
            pagination={false}
            size="small"
            columns={[
              {
                title: t('Field Name'),
                dataIndex: 'name',
                key: 'name',
              },
              {
                title: t('Field Title'),
                dataIndex: 'title',
                key: 'title',
              },
              {
                title: t('Field Type'),
                dataIndex: 'type',
                key: 'type',
              },
            ]}
          />
        </Card>
      )}
    </Card>
  );
};

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Checkbox, DatePicker, useAPIClient, useApp, useCompile, useNoticeSub } from '@tachybase/client';
import { FormItem } from '@tego/client';

import { InboxOutlined, LoadingOutlined, PlusOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Divider,
  Dropdown,
  Menu,
  message,
  Modal,
  Progress,
  Row,
  Space,
  Spin,
  Table,
  Tabs,
  Upload,
  UploadProps,
  type CheckboxProps,
} from 'antd';
import { saveAs } from 'file-saver';

import { BackupProgressCell } from './components/BackupProgressCell';
import { useBackupProgress } from './hooks/useBackupProgress';
import { useDownloadProgress } from './hooks/useDownloadProgress';
import { useDuplicatorTranslation } from './locale';

const { Dragger } = Upload;

function useUploadProps(props: UploadProps): any {
  const onChange = (param) => {
    props.onChange?.(param);
  };

  const api = useAPIClient();

  return {
    ...props,
    customRequest({ action, data, file, filename, headers, onError, onProgress, onSuccess, withCredentials }) {
      const formData = new FormData();
      if (data) {
        Object.keys(data).forEach((key) => {
          formData.append(key, data[key]);
        });
      }
      formData.append(filename, file);
      // eslint-disable-next-line promise/catch-or-return
      api.axios
        .post(action, formData, {
          withCredentials,
          headers,
          onUploadProgress: ({ total, loaded }) => {
            onProgress({ percent: Math.round((loaded / total) * 100).toFixed(2) }, file);
          },
        })
        .then(({ data }) => {
          onSuccess(data, file);
        })
        .catch(onError)
        .finally(() => {});

      return {
        abort() {
          // Upload aborted
        },
      };
    },
    onChange,
  };
}

const LearnMore: any = (props: { collectionsData?: any; isBackup?: boolean }) => {
  const { collectionsData } = props;
  const { t } = useDuplicatorTranslation();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [dataSource, setDataSource] = useState<any>(collectionsData);
  useEffect(() => {
    setDataSource(collectionsData);
  }, [collectionsData]);
  const apiClient = useAPIClient();
  const compile = useCompile();
  const resource = useMemo(() => {
    return apiClient.resource('backupFiles');
  }, [apiClient]);
  const showModal = async () => {
    if (props.isBackup) {
      const data = await resource.dumpableCollections();
      setDataSource(data?.data);
      setIsModalOpen(true);
    }
    setIsModalOpen(true);
  };

  const handleOk = () => {
    setIsModalOpen(false);
  };

  const handleCancel = () => {
    setIsModalOpen(false);
  };
  const columns = [
    {
      title: t('Collection'),
      dataIndex: 'collection',
      key: 'collection',
      render: (_, data) => {
        const title = compile(data.title);
        const name = data.name;
        return name === title ? (
          title
        ) : (
          <div>
            {data.name} <span style={{ color: 'rgba(0, 0, 0, 0.3)', fontSize: '0.9em' }}>({compile(data.title)})</span>
          </div>
        );
      },
    },
    {
      title: t('Origin'),
      dataIndex: 'origin',
      key: 'origin',
      width: '50%',
    },
  ];
  const items = Object.keys(dataSource || {}).map((item) => {
    return {
      key: item,
      label: t(`${item}.title`),
      children: (
        <>
          <Alert style={{ marginBottom: 16 }} message={t(`${item}.description`)} />
          <Table
            pagination={{ pageSize: 100 }}
            bordered
            size={'small'}
            dataSource={dataSource[item]}
            columns={columns}
            scroll={{ y: 400 }}
          />
        </>
      ),
    };
  });

  return (
    <>
      <a onClick={showModal}>{t('Learn more')}</a>
      <Modal
        title={t('Backup instructions')}
        width={'80vw'}
        open={isModalOpen}
        footer={null}
        onOk={handleOk}
        onCancel={handleCancel}
      >
        <Tabs defaultActiveKey="required" items={items} />
      </Modal>
    </>
  );
};

const Restore = ({ ButtonComponent = Button, title, upload = false, fileData }: any) => {
  const { t } = useDuplicatorTranslation();
  const [dataTypes, setDataTypes] = useState<any[]>(['required']);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [restoreData, setRestoreData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const apiClient = useAPIClient();
  const resource = useMemo(() => {
    return apiClient.resource('backupFiles');
  }, [apiClient]);
  const [dataSource, setDataSource] = useState([]);

  const indeterminate = dataTypes.length > 0 && dataTypes.length < dataSource.length;
  const checkAll = dataSource.length === dataTypes.length;

  useEffect(() => {
    const newDataSource = Object.keys(restoreData?.dumpableCollectionsGroupByGroup || []).map((key) => ({
      value: key,
      label: t(`${key}.title`),
      disabled: ['required', 'skipped'].includes(key),
    }));
    setDataSource(newDataSource);
    // 默认全选
    if (newDataSource.length > 0) {
      setDataTypes(newDataSource.map((item) => item.value));
    }
  }, [restoreData, t]);

  const showModal = async () => {
    setIsModalOpen(true);
    if (!upload) {
      setLoading(true);
      const { data } = await resource.get({ filterByTk: fileData.name });
      const newDataSource = Object.keys(data?.data?.meta?.dumpableCollectionsGroupByGroup || []).map((key) => ({
        value: key,
        label: t(`${key}.title`),
        disabled: ['required', 'skipped'].includes(key),
      }));
      setDataSource(newDataSource);
      setRestoreData(data?.data?.meta);
      // 默认全选
      if (newDataSource.length > 0) {
        setDataTypes(newDataSource.map((item) => item.value));
      }
      setLoading(false);
    }
  };
  const handleOk = () => {
    resource.restore({
      values: {
        dataTypes,
        filterByTk: fileData?.name,
        key: restoreData?.key,
      },
    });
    setIsModalOpen(false);
  };

  const handleCancel = () => {
    setIsModalOpen(false);
    setRestoreData(null);
    // 重置时保持全选状态（如果有数据源）
    if (dataSource.length > 0) {
      setDataTypes(dataSource.map((item) => item.value));
    } else {
      setDataTypes(['required']);
    }
  };

  const onCheckAllChange: CheckboxProps['onChange'] = (e) => {
    setDataTypes(e.target.checked ? dataSource.map((item) => item.value) : ['required']);
  };

  return (
    <>
      <ButtonComponent onClick={showModal}>{title}</ButtonComponent>
      <Modal
        title={t('Restore')}
        width={800}
        footer={upload && !restoreData ? null : undefined}
        open={isModalOpen}
        onOk={handleOk}
        onCancel={handleCancel}
      >
        <Spin spinning={loading}>
          {upload && !restoreData && <RestoreUpload setRestoreData={setRestoreData} />}
          {(!upload || restoreData) && [
            <strong style={{ fontWeight: 600, display: 'block', margin: '16px 0 8px' }} key="info">
              {t('Select the data to be restored')} (
              <LearnMore collectionsData={restoreData?.dumpableCollectionsGroupByGroup} />
              ):
            </strong>,
            <div style={{ lineHeight: 2, marginBottom: 8 }} key="dataType">
              <FormItem>
                <Checkbox.Group
                  options={dataSource}
                  style={{ flexDirection: 'column' }}
                  value={dataTypes}
                  onChange={(checkValue) => setDataTypes(checkValue)}
                />
                <Divider />
                <Checkbox indeterminate={indeterminate} onChange={onCheckAllChange} checked={checkAll}>
                  {t('Check all')}
                </Checkbox>
              </FormItem>
            </div>,
          ]}
        </Spin>
      </Modal>
    </>
  );
};

const NewBackup = ({ ButtonComponent = Button, refresh }) => {
  const { t } = useDuplicatorTranslation();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [dataTypes, setBackupData] = useState<any[]>(['required']);
  const apiClient = useAPIClient();
  const [dataSource, setDataSource] = useState([]);
  const commonTypes = ['required', 'user', 'third-party', 'custom'];

  const indeterminate =
    dataTypes.length > 0 && dataTypes.length < dataSource.filter((item) => item.value !== 'skipped').length;

  const checkAll = dataSource.filter((item) => item.value !== 'skipped').length === dataTypes.length;

  const onCheckAllChange: CheckboxProps['onChange'] = (e) => {
    setBackupData(
      e.target.checked ? dataSource.filter((item) => item.value !== 'skipped').map((item) => item.value) : ['required'],
    );
  };

  const onCheckCommonChange: CheckboxProps['onChange'] = (e) => {
    const availableCommonTypes = dataSource
      .filter((item) => commonTypes.includes(item.value) && item.value !== 'skipped')
      .map((item) => item.value);
    if (e.target.checked) {
      // 选择常用时，保留 required，并添加常用类型
      const newDataTypes = [...new Set([...dataTypes.filter((type) => type === 'required'), ...availableCommonTypes])];
      setBackupData(newDataTypes);
    } else {
      // 取消选择常用时，只保留 required
      setBackupData(['required']);
    }
  };

  const isCommonChecked = useMemo(() => {
    const availableCommonTypes = dataSource
      .filter((item) => commonTypes.includes(item.value) && item.value !== 'skipped')
      .map((item) => item.value);
    const selectedCommonTypes = availableCommonTypes.filter((type) => dataTypes.includes(type));
    // 检查：所有常用类型都被选中，且没有其他非常用类型（除了 required）被选中
    const otherTypes = dataTypes.filter((type) => type !== 'required' && !availableCommonTypes.includes(type));
    return (
      availableCommonTypes.length > 0 &&
      selectedCommonTypes.length === availableCommonTypes.length &&
      otherTypes.length === 0
    );
  }, [dataTypes, dataSource]);

  const isCommonIndeterminate = useMemo(() => {
    const availableCommonTypes = dataSource
      .filter((item) => commonTypes.includes(item.value) && item.value !== 'skipped')
      .map((item) => item.value);
    const selectedCommonTypes = availableCommonTypes.filter((type) => dataTypes.includes(type));
    return selectedCommonTypes.length > 0 && selectedCommonTypes.length < availableCommonTypes.length;
  }, [dataTypes, dataSource]);

  const showModal = async () => {
    const { data } = await apiClient.resource('backupFiles').dumpableCollections();
    const newDataSource = Object.keys(data || []).map((key) => ({
      value: key,
      label: t(`${key}.title`),
      disabled: ['required', 'skipped'].includes(key),
    }));
    setDataSource(newDataSource);

    // 默认选择常用类型
    const availableCommonTypes = newDataSource
      .filter((item) => commonTypes.includes(item.value) && item.value !== 'skipped')
      .map((item) => item.value);
    setBackupData(['required', ...availableCommonTypes]);

    setIsModalOpen(true);
  };

  const handleOk = async (method) => {
    await apiClient.request({
      url: 'backupFiles:create',
      method: 'post',
      data: {
        dataTypes,
        method,
      },
    });
    setIsModalOpen(false);
    // 重置为常用类型
    const availableCommonTypes = dataSource
      .filter((item) => commonTypes.includes(item.value) && item.value !== 'skipped')
      .map((item) => item.value);
    setBackupData(['required', ...availableCommonTypes]);
    // 立即刷新列表以显示新创建的备份任务
    // 使用较短的延迟确保后端已经创建了 lock 文件
    setTimeout(() => {
      refresh();
    }, 500);
  };

  const handleCancel = () => {
    setIsModalOpen(false);
    // 重置为常用类型
    const availableCommonTypes = dataSource
      .filter((item) => commonTypes.includes(item.value) && item.value !== 'skipped')
      .map((item) => item.value);
    setBackupData(['required', ...availableCommonTypes]);
  };

  return (
    <>
      <ButtonComponent icon={<PlusOutlined />} type="primary" onClick={showModal}>
        {t('New backup')}
      </ButtonComponent>
      <Modal
        title={t('New backup')}
        width={800}
        open={isModalOpen}
        // onOk={handleOk}
        onCancel={handleCancel}
        footer={[
          <Row gutter={16} justify="end" align="middle">
            <Col>
              <Button key="cancel" onClick={handleCancel}>
                {t('Cancel')}
              </Button>
            </Col>
            <Col>
              <Dropdown.Button
                key="submit"
                type="primary"
                onClick={() => handleOk('priority')}
                overlay={
                  <Menu>
                    <Menu.Item key="main" onClick={() => handleOk('main')}>
                      {t('Self backup')}
                    </Menu.Item>
                    <Menu.Item key="worker" onClick={() => handleOk('worker')}>
                      {t('Worker backup')}
                    </Menu.Item>
                  </Menu>
                }
              >
                {t('Backup')}
              </Dropdown.Button>
            </Col>
          </Row>,
        ]}
      >
        <strong style={{ fontWeight: 600, display: 'block', margin: '16px 0 8px' }}>
          {t('Select the data to be backed up')} (
          <LearnMore isBackup={true} />
          ):
        </strong>
        <div style={{ lineHeight: 2, marginBottom: 8 }}>
          <Checkbox.Group
            options={dataSource}
            style={{ flexDirection: 'column' }}
            onChange={(checkValue) => setBackupData(checkValue)}
            value={dataTypes}
          />
          <Divider />
          <Space>
            <Checkbox indeterminate={isCommonIndeterminate} onChange={onCheckCommonChange} checked={isCommonChecked}>
              {t('Check common')}
            </Checkbox>
            <Checkbox indeterminate={indeterminate} onChange={onCheckAllChange} checked={checkAll}>
              {t('Check all')}
            </Checkbox>
          </Space>
        </div>
      </Modal>
    </>
  );
};

const RestoreUpload = (props: any) => {
  const { t } = useDuplicatorTranslation();
  const uploadProps: UploadProps = {
    multiple: false,
    action: '/backupFiles:upload',
    onChange(info) {
      if (info.fileList.length > 1) {
        info.fileList.splice(0, info.fileList.length - 1); // 只保留一个文件
      }
      const { status } = info.file;
      if (status === 'done') {
        message.success(`${info.file.name} ` + t('file uploaded successfully'));
        props.setRestoreData({ ...info.file.response?.data?.meta, key: info.file.response?.data.key });
      } else if (status === 'error') {
        message.error(`${info.file.name} ` + t('file upload failed'));
      }
    },
    onDrop(e) {
      // Files dropped
    },
  };

  return (
    <Dragger {...useUploadProps(uploadProps)}>
      <p className="ant-upload-drag-icon">
        <InboxOutlined />
      </p>
      <p className="ant-upload-text"> {t('Click or drag file to this area to upload')}</p>
    </Dragger>
  );
};

export const BackupAndRestoreList = () => {
  const { t } = useDuplicatorTranslation();
  const apiClient = useAPIClient();
  const app = useApp();
  const [dataSource, setDataSource] = useState([]);
  const [loading, setLoading] = useState(false);
  const { modal, notification } = App.useApp();
  const [downloadModalVisible, setDownloadModalVisible] = useState(false);
  const [downloadingFileName, setDownloadingFileName] = useState<string>('');
  const resource = useMemo(() => {
    return apiClient.resource('backupFiles');
  }, [apiClient]);

  // 使用下载进度 hook
  const { downloadProgress, handleDownload } = useDownloadProgress({
    onDownloadStart: (fileName) => {
      setDownloadingFileName(fileName);
      setDownloadModalVisible(true);
    },
    onDownloadComplete: (fileName, blob) => {
      saveAs(blob, fileName);
      setDownloadModalVisible(false);
      setDownloadingFileName('');
      notification.success({
        key: 'downloadBackup',
        message: <span>{t('Downloaded success!')}</span>,
        duration: 1,
      });
    },
    onDownloadError: (fileName, error) => {
      setDownloadModalVisible(false);
      setDownloadingFileName('');
      notification.error({
        key: 'downloadBackup',
        message: <span>{t('Download failed')}</span>,
        duration: 3,
      });
    },
  });

  const queryFieldList = useCallback(
    async (showLoading = true) => {
      if (showLoading) {
        setLoading(true);
      }
      try {
        const { data } = await resource.list();
        // 后端返回的数据结构是 { rows: [...], count: ..., page: ..., pageSize: ..., totalPage: ... }
        const newDataSource = data?.rows || data?.data || [];
        setDataSource(newDataSource);
      } finally {
        if (showLoading) {
          setLoading(false);
        }
      }
    },
    [resource],
  );

  const handleRefresh = useCallback(async () => {
    await queryFieldList();
  }, [queryFieldList]);

  useNoticeSub('backup', (message) => {
    let func = notification[message.level] || notification.info;
    func({
      key: 'backup',
      message: message.msg,
    });
    handleRefresh();
  });

  useEffect(() => {
    queryFieldList();
  }, [queryFieldList]);

  // 使用备份进度 hook，监听 WebSocket 消息
  useBackupProgress({
    dataSource,
    onDataSourceUpdate: setDataSource,
    onComplete: (fileName) => {
      // 进度达到 100% 时刷新列表
      queryFieldList(false);
    },
    onTimeout: (fileName) => {
      // 备份任务超时时显示通知
      notification.error({
        key: 'backup-timeout',
        message: t('Backup timeout', { ns: 'backup' }),
        description: `${fileName} ${t('No progress update received for a long time', { ns: 'backup' })}`,
        duration: 5,
      });
      // 刷新列表以更新状态
      queryFieldList(false);
    },
  });

  // 自动轮询机制：当有进行中的备份任务时，定期轮询 API 获取进度
  // 只在 WebSocket 不可用或未连接时启用轮询，避免与 WebSocket 推送冲突
  // 这样可以确保在 worker 线程中（WebSocket 不可用）也能实时更新进度
  useEffect(() => {
    const hasInProgressBackup = dataSource.some((item: any) => item.inProgress || item.status === 'in_progress');

    if (!hasInProgressBackup) {
      return;
    }

    // 如果 WebSocket 可用且已连接，不启用轮询，避免与 WebSocket 推送冲突
    // 只在 WebSocket 不可用或未连接时才启用轮询
    const shouldPoll = !app.ws?.enabled || !app.ws?.connected;

    if (!shouldPoll) {
      return;
    }

    // 每 2 秒轮询一次进度（在 worker 线程中，进度保存在文件中，API 可以读取）
    const pollInterval = setInterval(() => {
      queryFieldList(false);
    }, 2000);

    return () => {
      clearInterval(pollInterval);
    };
  }, [dataSource, queryFieldList, app.ws]);
  const handleDestory = (fileData) => {
    modal.confirm({
      title: t('Delete record', { ns: 'core' }),
      content: t('Are you sure you want to delete it?', { ns: 'core' }),
      onOk: async () => {
        await resource.destroy({ filterByTk: fileData.name });
        await queryFieldList();
        message.success(t('Deleted successfully'));
      },
    });
  };

  return (
    <div>
      <Card bordered={false}>
        <Space style={{ float: 'right', marginBottom: 16 }}>
          <Button onClick={handleRefresh} icon={<ReloadOutlined />}>
            {t('Refresh')}
          </Button>
          <Restore
            upload
            title={
              <>
                <UploadOutlined /> {t('Restore backup from local')}
              </>
            }
          />
          <NewBackup refresh={handleRefresh} />
        </Space>
        <Table<any>
          dataSource={dataSource}
          loading={loading}
          columns={[
            {
              title: t('Backup file'),
              dataIndex: 'name',
              width: 400,
              onCell: (data) => {
                return data.inProgress
                  ? {
                      colSpan: 1,
                    }
                  : {};
              },
              render: (name, data) =>
                data.status === 'error' ? (
                  <div style={{ color: 'red' }}>
                    {name}({t('Error')})
                  </div>
                ) : (
                  <div>{name}</div>
                ),
            },
            {
              title: t('Backup progress'),
              dataIndex: 'progress',
              width: 200,
              align: 'center',
              render: (_, record) => {
                return (
                  <BackupProgressCell
                    inProgress={record.inProgress}
                    status={record.status}
                    progress={record.progress}
                    currentStep={record.currentStep}
                    downloadProgress={downloadProgress[record.name]}
                    showDownloadText={false}
                  />
                );
              },
            },
            {
              title: t('File size'),
              dataIndex: 'fileSize',
              width: 150,
              render: (value, record) => {
                const percent = record.progress ?? 0;
                const stepText = record.currentStep || t('Backing up');
                return record.inProgress ? (
                  <div
                    style={{
                      width: '150px',
                      fontSize: '12px',
                      color: 'rgba(0, 0, 0, 0.45)',
                      marginTop: '4px',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {percent > 0 ? `${percent}%` : ''}&nbsp;{stepText}
                  </div>
                ) : (
                  value
                );
              },
            },
            {
              title: t('Created at', { ns: 'core' }),
              dataIndex: 'createdAt',
              onCell: (data) => {
                return data.inProgress
                  ? {
                      colSpan: 0,
                    }
                  : {};
              },
              render: (value) => {
                return <DatePicker.ReadPretty value={value} showTime />;
              },
            },
            {
              title: t('Actions', { ns: 'core' }),
              dataIndex: 'actions',
              onCell: (data) => {
                return data.inProgress
                  ? {
                      colSpan: 0,
                    }
                  : {};
              },
              render: (_, record) => (
                <Space split={<Divider type="vertical" />}>
                  {record.status !== 'error' && (
                    <Restore ButtonComponent={'a'} title={t('Restore')} fileData={record} />
                  )}
                  {record.status !== 'error' && (
                    <a type="link" onClick={() => handleDownload(record)}>
                      {t('Download')}
                    </a>
                  )}
                  <a onClick={() => handleDestory(record)}>{t('Delete')}</a>
                </Space>
              ),
            },
          ]}
        />
      </Card>
      {/* 下载进度弹窗 */}
      <Modal
        title={t('Downloading')}
        open={downloadModalVisible}
        closable={false}
        maskClosable={false}
        footer={null}
        width={400}
      >
        <div style={{ padding: '20px 0' }}>
          <div style={{ marginBottom: 16, fontSize: '14px', color: 'rgba(0, 0, 0, 0.65)' }}>{downloadingFileName}</div>
          <Progress
            percent={downloadingFileName ? downloadProgress[downloadingFileName] || 0 : 0}
            status="active"
            showInfo
            format={(percent) => `${percent}%`}
          />
        </div>
      </Modal>
    </div>
  );
};

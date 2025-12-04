import { useCallback, useEffect, useMemo, useState } from 'react';
import { DatePicker, useAPIClient } from '@tachybase/client';

import { DeleteOutlined, DownloadOutlined, ReloadOutlined, SaveOutlined, WarningOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, InputNumber, Modal, Progress, Radio, Space, Spin, Table, Typography } from 'antd';
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
  minId: number | null;
  maxId: number | null;
}

interface FilterState {
  createdAt?: [dayjs.Dayjs | null, dayjs.Dayjs | null];
  updatedAt?: [dayjs.Dayjs | null, dayjs.Dayjs | null];
  idRange?: [number | null, number | null];
}

/**
 * 构建筛选参数
 */
function buildFilterParams(filter: FilterState): Record<string, any> {
  const filterParams: Record<string, any> = {};

  if (filter.createdAt && filter.createdAt[0] && filter.createdAt[1]) {
    const start = dayjs(filter.createdAt[0]);
    const end = dayjs(filter.createdAt[1]);
    if (start.isValid() && end.isValid()) {
      filterParams.createdAt = {
        $gte: start.startOf('day').toISOString(),
        $lte: end.endOf('day').toISOString(),
      };
    }
  }

  if (filter.updatedAt && filter.updatedAt[0] && filter.updatedAt[1]) {
    const start = dayjs(filter.updatedAt[0]);
    const end = dayjs(filter.updatedAt[1]);
    if (start.isValid() && end.isValid()) {
      filterParams.updatedAt = {
        $gte: start.startOf('day').toISOString(),
        $lte: end.endOf('day').toISOString(),
      };
    }
  }

  // ID 范围筛选
  if (filter.idRange && (filter.idRange[0] !== null || filter.idRange[1] !== null)) {
    filterParams.id = {};
    if (filter.idRange[0] !== null) {
      filterParams.id.$gte = filter.idRange[0];
    }
    if (filter.idRange[1] !== null) {
      filterParams.id.$lte = filter.idRange[1];
    }
  }

  return filterParams;
}

export const TableDetail = () => {
  const { t } = useTranslation();
  const apiClient = useAPIClient();
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  // 从路径中提取表名，路径格式：/admin/settings/system-services/database-clean/:tableName
  const tableName = params.tableName || location.pathname.split('/').pop();
  const { message, modal, notification } = App.useApp();

  const [tableInfo, setTableInfo] = useState<TableInfo | null>(null);
  const [dataSource, setDataSource] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [backupLoading, setBackupLoading] = useState(false);
  const [downloadLoading, setDownloadLoading] = useState(false);
  const [cleanLoading, setCleanLoading] = useState(false);
  const [vacuumLoading, setVacuumLoading] = useState(false);
  const [backupFileName, setBackupFileName] = useState<string | null>(null);
  const [cleanModalVisible, setCleanModalVisible] = useState(false);
  const [backupDownloadModalVisible, setBackupDownloadModalVisible] = useState(false);
  const [batchSettingModalVisible, setBatchSettingModalVisible] = useState(false);
  const [vacuumModalVisible, setVacuumModalVisible] = useState(false);
  const [pendingCleanFilter, setPendingCleanFilter] = useState<Record<string, any> | null>(null);
  // 符合筛选条件的数据的 ID 范围和数量
  const [filteredDataInfo, setFilteredDataInfo] = useState<{
    count: number;
    minId: number | null;
    maxId: number | null;
  }>({ count: 0, minId: null, maxId: null });
  // 分批设置
  const [batchMode, setBatchMode] = useState<'none' | 'count' | 'size'>('none');
  const [batchCount, setBatchCount] = useState<number>(10);
  const [batchSize, setBatchSize] = useState<number>(10000);
  // 清理进度
  const [cleanProgress, setCleanProgress] = useState<{
    current: number;
    total: number;
    deletedCount: number;
  } | null>(null);
  const [pagination, setPagination] = useState({
    current: 1,
    pageSize: 20,
    total: 0,
  });

  const [filter, setFilter] = useState<FilterState>({});

  // 是否正在处理中（备份、下载、清理、释放空间）
  const isProcessing = backupLoading || downloadLoading || cleanLoading || vacuumLoading;

  const resource = useMemo(() => {
    return apiClient.resource('databaseClean');
  }, [apiClient]);

  useEffect(() => {
    if (tableName) {
      loadTableInfo();
    }
  }, [tableName]);

  // 只有当 tableInfo 加载完成后，才加载数据
  useEffect(() => {
    if (tableName && tableInfo) {
      loadTableData();
    }
  }, [tableName, tableInfo, pagination.current, pagination.pageSize, filter]);

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
      const filterParams = buildFilterParams(filter);

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
      // 保存符合筛选条件的数据信息
      setFilteredDataInfo({
        count: meta?.count || 0,
        minId: meta?.filteredMinId ?? null,
        maxId: meta?.filteredMaxId ?? null,
      });
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
      const filterParams = buildFilterParams(filter);

      const response = await resource.backup({
        values: {
          collectionName: tableName,
          filter: Object.keys(filterParams).length > 0 ? filterParams : undefined,
        },
      });

      // Axios 响应格式: response.data = { data: {...} }
      const fileName = response.data?.data?.fileName;
      setBackupFileName(fileName);
      message.success(t('Backup Success'));
      return fileName;
    } catch (error) {
      message.error(error.message || t('Backup Failed'));
      return null;
    } finally {
      setBackupLoading(false);
    }
  };

  const handleDownload = async (fileName?: string) => {
    const fileToDownload = fileName || backupFileName;
    if (!fileToDownload) return;
    setDownloadLoading(true);
    try {
      const data = await apiClient.request({
        url: 'databaseClean:download',
        method: 'get',
        params: {
          filterByTk: fileToDownload,
        },
        responseType: 'blob',
      });
      const blob = new Blob([data.data]);
      saveAs(blob, fileToDownload);
      message.success(t('Download') + ' ' + t('Success'));
      return true;
    } catch (error) {
      message.error(error.message || t('Download') + ' ' + t('Failed'));
      return false;
    } finally {
      setDownloadLoading(false);
    }
  };

  // 打开清理确认弹窗
  const handleClean = () => {
    setCleanModalVisible(true);
  };

  // 先备份再清理
  const handleBackupThenClean = async () => {
    const fileName = await handleBackup();
    if (fileName) {
      setBackupFileName(fileName);
      // 保存当前筛选条件
      setPendingCleanFilter(buildFilterParams(filter));
      // 关闭清理确认弹窗，打开下载确认弹窗
      setCleanModalVisible(false);
      setBackupDownloadModalVisible(true);
    }
  };

  // 下载后继续清理
  const handleDownloadThenClean = async () => {
    const success = await handleDownload(backupFileName!);
    if (success) {
      setBackupDownloadModalVisible(false);
      // 打开分批设置弹窗
      setBatchSettingModalVisible(true);
    }
  };

  // 跳过下载直接清理
  const handleSkipDownloadAndClean = () => {
    setBackupDownloadModalVisible(false);
    // 打开分批设置弹窗
    setBatchSettingModalVisible(true);
  };

  // 直接清理（不备份）
  const handleCleanDirectly = async () => {
    // 保存当前筛选条件
    setPendingCleanFilter(buildFilterParams(filter));
    setCleanModalVisible(false);
    // 打开分批设置弹窗
    setBatchSettingModalVisible(true);
  };

  // 确认分批设置，进入 VACUUM 确认
  const handleConfirmBatchSetting = () => {
    setBatchSettingModalVisible(false);
    setVacuumModalVisible(true);
  };

  // 执行清理（带可选的 VACUUM FULL）
  const handleConfirmVacuum = async (vacuumFull: boolean) => {
    setVacuumModalVisible(false);
    await doClean(vacuumFull);
  };

  const doClean = async (vacuumFull = false) => {
    if (!tableName) return;
    setCleanLoading(true);
    setCleanProgress(null);

    try {
      // 使用保存的筛选条件或当前筛选条件
      const baseFilter = pendingCleanFilter || buildFilterParams(filter);
      let totalDeletedCount = 0;

      // 计算分批信息
      const { minId, maxId, count } = filteredDataInfo;
      let batches: Array<{ minId: number; maxId: number }> = [];

      if (batchMode !== 'none' && minId !== null && maxId !== null && count > 0) {
        const idRange = maxId - minId + 1;
        let numBatches: number;

        if (batchMode === 'count') {
          numBatches = batchCount;
        } else {
          // batchMode === 'size'
          numBatches = Math.ceil(count / batchSize);
        }

        // 确保至少 1 批
        numBatches = Math.max(1, numBatches);

        const batchIdSize = Math.ceil(idRange / numBatches);

        for (let i = 0; i < numBatches; i++) {
          const batchMinId = minId + i * batchIdSize;
          const batchMaxId = Math.min(minId + (i + 1) * batchIdSize - 1, maxId);
          batches.push({ minId: batchMinId, maxId: batchMaxId });
        }
      }

      if (batches.length > 1) {
        // 分批清理
        setCleanProgress({ current: 0, total: batches.length, deletedCount: 0 });

        for (let i = 0; i < batches.length; i++) {
          const batch = batches[i];
          const batchFilter = {
            ...baseFilter,
            id: {
              ...baseFilter.id,
              $gte: batch.minId,
              $lte: batch.maxId,
            },
          };
          // 仅在最后一批时执行 VACUUM FULL
          const isLastBatch = i === batches.length - 1;

          const response = await resource.clean({
            values: {
              collectionName: tableName,
              filter: batchFilter,
              vacuumFull: isLastBatch && vacuumFull,
            },
          });

          const deletedCount = response.data?.data?.deletedCount || 0;
          totalDeletedCount += deletedCount;

          setCleanProgress({
            current: i + 1,
            total: batches.length,
            deletedCount: totalDeletedCount,
          });
        }
      } else {
        // 不分批，一次性清理
        const response = await resource.clean({
          values: {
            collectionName: tableName,
            filter: Object.keys(baseFilter).length > 0 ? baseFilter : undefined,
            vacuumFull,
          },
        });

        totalDeletedCount = response.data?.data?.deletedCount || 0;
      }

      message.success(t('Clean Success') + ` (${totalDeletedCount} ${t('records deleted')})`);
      if (vacuumFull) {
        message.success(t('Space released successfully'));
      }

      // 重置状态
      setBackupFileName(null);
      setPendingCleanFilter(null);
      setCleanProgress(null);
      setBatchMode('none');
      // 重置筛选条件，避免旧的筛选范围超出新数据范围
      setFilter({});
      // 重置分页到第一页
      setPagination((prev) => ({ ...prev, current: 1 }));

      // 重新加载表信息（会更新 minId、maxId 等）
      await loadTableInfo();
    } catch (error) {
      message.error(error.message || t('Clean Failed'));
    } finally {
      setCleanLoading(false);
      setCleanProgress(null);
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
              {/* ID 范围筛选 - 适用于没有时间字段的表 */}
              <div>
                <label>{t('ID Range')}: </label>
                <Space>
                  <InputNumber
                    placeholder={t('Min ID')}
                    value={filter.idRange?.[0]}
                    onChange={(value) => {
                      setFilter((prev) => {
                        // 如果新的最小值大于当前最大值，则调整最大值
                        const newMax = prev.idRange?.[1];
                        if (value !== null && newMax !== null && value > newMax) {
                          return { ...prev, idRange: [value, value] };
                        }
                        return { ...prev, idRange: [value, newMax ?? null] };
                      });
                    }}
                    style={{ width: 150 }}
                    min={tableInfo.minId ?? 0}
                    max={filter.idRange?.[1] ?? tableInfo.maxId ?? undefined}
                  />
                  <span>-</span>
                  <InputNumber
                    placeholder={t('Max ID')}
                    value={filter.idRange?.[1]}
                    onChange={(value) => {
                      setFilter((prev) => {
                        // 如果新的最大值小于当前最小值，则调整最小值
                        const newMin = prev.idRange?.[0];
                        if (value !== null && newMin !== null && value < newMin) {
                          return { ...prev, idRange: [value, value] };
                        }
                        return { ...prev, idRange: [newMin ?? null, value] };
                      });
                    }}
                    style={{ width: 150 }}
                    min={filter.idRange?.[0] ?? tableInfo.minId ?? 0}
                    max={tableInfo.maxId ?? undefined}
                  />
                </Space>
              </div>
              {!tableInfo.hasCreatedAt && !tableInfo.hasUpdatedAt && (
                <Alert message={t('No time fields, use ID range filter')} type="info" showIcon />
              )}
            </Space>
          </Card>

          {/* 操作按钮 */}
          <Space>
            <Button onClick={loadTableData} icon={<ReloadOutlined />} disabled={isProcessing}>
              {t('Refresh')}
            </Button>
            <Button
              danger
              icon={<DeleteOutlined />}
              loading={cleanLoading}
              disabled={isProcessing}
              onClick={handleClean}
            >
              {cleanLoading
                ? cleanProgress
                  ? `(${cleanProgress.current}/${cleanProgress.total}) ${t('Cleaning...')}`
                  : t('Cleaning...')
                : t('Clean')}
            </Button>
          </Space>

          {/* 清理确认弹窗 */}
          <Modal
            title={
              <Space>
                <WarningOutlined style={{ color: '#faad14' }} />
                {t('Confirm Clean')}
              </Space>
            }
            open={cleanModalVisible}
            onCancel={() => !isProcessing && setCleanModalVisible(false)}
            closable={!isProcessing}
            maskClosable={!isProcessing}
            keyboard={!isProcessing}
            footer={null}
            width={500}
          >
            <Space direction="vertical" style={{ width: '100%' }} size="middle">
              <Alert
                message={t('This action cannot be undone')}
                description={t('Are you sure you want to clean the filtered data?')}
                type="warning"
                showIcon
              />

              <Typography.Text type="secondary">
                {t('It is recommended to backup before cleaning. You can also clean directly without backup.')}
              </Typography.Text>

              <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
                <Button onClick={() => setCleanModalVisible(false)} disabled={isProcessing}>
                  {t('Cancel')}
                </Button>
                <Button
                  icon={<SaveOutlined />}
                  loading={backupLoading}
                  disabled={isProcessing}
                  onClick={handleBackupThenClean}
                >
                  {t('Backup then Clean')}
                </Button>
                <Button danger icon={<DeleteOutlined />} disabled={isProcessing} onClick={handleCleanDirectly}>
                  {t('Clean directly')}
                </Button>
              </Space>
            </Space>
          </Modal>

          {/* 备份下载确认弹窗 */}
          <Modal
            title={t('Backup Complete')}
            open={backupDownloadModalVisible}
            onCancel={() => !isProcessing && setBackupDownloadModalVisible(false)}
            closable={!isProcessing}
            maskClosable={!isProcessing}
            keyboard={!isProcessing}
            footer={null}
            width={450}
          >
            <Space direction="vertical" style={{ width: '100%' }} size="middle">
              <Typography.Text>{t('Do you want to download the backup file before cleaning?')}</Typography.Text>

              <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
                <Button onClick={() => setBackupDownloadModalVisible(false)} disabled={isProcessing}>
                  {t('Cancel')}
                </Button>
                <Button onClick={handleSkipDownloadAndClean} disabled={isProcessing}>
                  {t('Skip download')}
                </Button>
                <Button
                  type="primary"
                  icon={<DownloadOutlined />}
                  loading={downloadLoading}
                  disabled={isProcessing && !downloadLoading}
                  onClick={handleDownloadThenClean}
                >
                  {t('Download and continue')}
                </Button>
              </Space>
            </Space>
          </Modal>

          {/* 分批设置弹窗 */}
          <Modal
            title={t('Batch Settings')}
            open={batchSettingModalVisible}
            onCancel={() => !isProcessing && setBatchSettingModalVisible(false)}
            closable={!isProcessing}
            maskClosable={!isProcessing}
            keyboard={!isProcessing}
            footer={null}
            width={550}
          >
            <Space direction="vertical" style={{ width: '100%' }} size="middle">
              <Typography.Text>
                {t('Total records to clean')}: <strong>{filteredDataInfo.count.toLocaleString()}</strong>
              </Typography.Text>

              <Radio.Group value={batchMode} onChange={(e) => setBatchMode(e.target.value)} style={{ width: '100%' }}>
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Radio value="none">{t('No batching')}</Radio>
                  <Radio value="count">
                    <Space>
                      {t('Split into')}
                      <InputNumber
                        min={2}
                        max={1000}
                        value={batchCount}
                        onChange={(v) => v && setBatchCount(v)}
                        changeOnWheel
                        disabled={batchMode !== 'count'}
                        style={{ width: 80 }}
                      />
                      {t('batches')}
                    </Space>
                  </Radio>
                  <Radio value="size">
                    <Space>
                      {t('Each batch')}
                      <InputNumber
                        min={1000}
                        max={1000000}
                        step={1000}
                        value={batchSize}
                        onChange={(v) => v && setBatchSize(v)}
                        changeOnWheel
                        disabled={batchMode !== 'size'}
                        style={{ width: 100 }}
                      />
                      {t('records')}
                    </Space>
                  </Radio>
                </Space>
              </Radio.Group>

              {/* 分批提示 */}
              <Alert
                type="info"
                showIcon
                message={
                  batchMode === 'none'
                    ? filteredDataInfo.count > 50000
                      ? t('Will clean {{count}} records at once. Large data volume may take a long time.', {
                          count: filteredDataInfo.count.toLocaleString(),
                        })
                      : t('Will clean {{count}} records at once.', {
                          count: filteredDataInfo.count.toLocaleString(),
                        })
                    : batchMode === 'count'
                      ? t('Will clean {{count}} records in {{batches}} batches, {{perBatch}} records per batch.', {
                          count: filteredDataInfo.count.toLocaleString(),
                          batches: batchCount,
                          perBatch: Math.ceil(filteredDataInfo.count / batchCount).toLocaleString(),
                        })
                      : t('Will clean {{count}} records in {{batches}} batches, {{perBatch}} records per batch.', {
                          count: filteredDataInfo.count.toLocaleString(),
                          batches: Math.ceil(filteredDataInfo.count / batchSize),
                          perBatch: batchSize.toLocaleString(),
                        })
                }
              />

              <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
                <Button onClick={() => setBatchSettingModalVisible(false)} disabled={isProcessing}>
                  {t('Cancel')}
                </Button>
                <Button type="primary" onClick={handleConfirmBatchSetting} disabled={isProcessing}>
                  {t('Next')}
                </Button>
              </Space>
            </Space>
          </Modal>

          {/* VACUUM 确认弹窗 */}
          <Modal
            title={
              <Space>
                <WarningOutlined style={{ color: '#faad14' }} />
                {t('Release disk space')}
              </Space>
            }
            open={vacuumModalVisible}
            onCancel={() => !isProcessing && setVacuumModalVisible(false)}
            closable={!isProcessing}
            maskClosable={!isProcessing}
            keyboard={!isProcessing}
            footer={null}
            width={550}
          >
            <Space direction="vertical" style={{ width: '100%' }} size="middle">
              {/* 清理进度显示 */}
              {cleanProgress && (
                <div>
                  <Typography.Text>
                    {t('Cleaning progress')}: {cleanProgress.current} / {cleanProgress.total} {t('batches')}
                  </Typography.Text>
                  <Progress percent={Math.round((cleanProgress.current / cleanProgress.total) * 100)} status="active" />
                  <Typography.Text type="secondary">
                    {t('Deleted')}: {cleanProgress.deletedCount.toLocaleString()} {t('records')}
                  </Typography.Text>
                </div>
              )}

              {!cleanProgress && (
                <>
                  <Typography.Text>{t('Do you want to release disk space after cleaning?')}</Typography.Text>

                  <Alert
                    message={t('Release space warning')}
                    description={
                      <>
                        {t(
                          'Releasing space will lock the table and may take a long time for large tables. Other operations on this table will be blocked during the process.',
                        )}
                        {batchMode !== 'none' && (
                          <>
                            <br />
                            <br />
                            {t('Space will be released only after the last batch is completed.')}
                          </>
                        )}
                      </>
                    }
                    type="warning"
                    showIcon
                  />

                  <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
                    <Button onClick={() => setVacuumModalVisible(false)} disabled={isProcessing}>
                      {t('Cancel')}
                    </Button>
                    <Button
                      onClick={() => handleConfirmVacuum(false)}
                      loading={cleanLoading}
                      disabled={isProcessing && !cleanLoading}
                    >
                      {t('Clean only')}
                    </Button>
                    <Button
                      danger
                      onClick={() => handleConfirmVacuum(true)}
                      loading={cleanLoading || vacuumLoading}
                      disabled={isProcessing && !(cleanLoading || vacuumLoading)}
                    >
                      {t('Clean and release space')}
                    </Button>
                  </Space>
                </>
              )}
            </Space>
          </Modal>

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

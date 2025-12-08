import React from 'react';

import { Progress } from 'antd';

import { useDuplicatorTranslation } from '../locale';

export interface BackupProgressCellProps {
  /**
   * 是否正在备份
   */
  inProgress?: boolean;
  /**
   * 状态：'in_progress' | 'ok' | 'error'
   */
  status?: 'in_progress' | 'ok' | 'error';
  /**
   * 进度百分比 (0-100)
   */
  progress?: number;
  /**
   * 当前步骤文本
   */
  currentStep?: string;
  /**
   * 下载进度百分比 (0-100)，如果提供则优先显示下载进度
   */
  downloadProgress?: number;
  /**
   * 是否显示下载进度文本
   */
  showDownloadText?: boolean;
  /**
   * 进度条宽度
   */
  width?: number | string;
}

/**
 * 备份进度单元格组件
 * 用于在表格中显示备份文件的进度状态
 */
export const BackupProgressCell: React.FC<BackupProgressCellProps> = ({
  inProgress = false,
  status,
  progress = 0,
  currentStep,
  downloadProgress,
  showDownloadText = true,
  width = '180px',
}) => {
  const { t } = useDuplicatorTranslation();

  // 检查是否正在备份（备份进度优先，下载进度不影响）
  if (inProgress || status === 'in_progress') {
    const percent = progress ?? 0;
    const stepText = currentStep || t('Backing up');
    return (
      <div style={{ width }}>
        <Progress percent={percent} status="active" showInfo={false} />
        {showDownloadText && (
          <div
            style={{
              fontSize: '12px',
              color: 'rgba(0, 0, 0, 0.45)',
              marginTop: '4px',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {stepText} {percent > 0 ? `${percent}%` : ''}
          </div>
        )}
      </div>
    );
  }

  // 错误状态
  if (status === 'error') {
    return (
      <div style={{ width }}>
        <Progress percent={0} status="exception" showInfo={false} />
      </div>
    );
  }

  // 完成状态
  if (status === 'ok') {
    return (
      <div style={{ width }}>
        <Progress percent={100} status="success" showInfo={false} />
      </div>
    );
  }

  // 如果不在备份中，且有下载进度，则显示下载进度
  if (downloadProgress !== undefined && downloadProgress >= 0) {
    return (
      <div key={`download-${downloadProgress}`} style={{ width }}>
        <Progress percent={downloadProgress} status="active" showInfo={false} />
        {showDownloadText && (
          <div
            style={{
              fontSize: '12px',
              color: 'rgba(0, 0, 0, 0.45)',
              marginTop: '4px',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {t('Downloading')} {downloadProgress}%
          </div>
        )}
      </div>
    );
  }

  return null;
};

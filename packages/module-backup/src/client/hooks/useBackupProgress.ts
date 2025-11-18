import { useEffect, useRef, useState } from 'react';
import { useApp } from '@tachybase/client';

export interface BackupProgressUpdate {
  fileName: string;
  progress: {
    percent: number;
    currentStep: string;
  };
}

export interface UseBackupProgressOptions {
  /**
   * 数据源，用于查找和更新对应文件的进度
   */
  dataSource: any[];
  /**
   * 更新数据源的回调函数
   */
  onDataSourceUpdate: (updater: (prev: any[]) => any[]) => void;
  /**
   * 当进度达到 100% 时的回调
   */
  onComplete?: (fileName: string) => void;
  /**
   * WebSocket 消息类型，默认为 'backup:progress'
   */
  messageType?: string;
}

/**
 * Hook：监听 WebSocket 消息，自动更新备份进度
 *
 * @example
 * ```tsx
 * const [dataSource, setDataSource] = useState([]);
 *
 * useBackupProgress({
 *   dataSource,
 *   onDataSourceUpdate: setDataSource,
 *   onComplete: (fileName) => {
 *     console.log('Backup completed:', fileName);
 *     refreshList();
 *   },
 * });
 * ```
 */
export function useBackupProgress({
  dataSource,
  onDataSourceUpdate,
  onComplete,
  messageType = 'backup:progress',
}: UseBackupProgressOptions) {
  const app = useApp();
  const onCompleteRef = useRef(onComplete);
  const dataSourceRef = useRef(dataSource);

  // 更新 ref，确保总是使用最新的值
  useEffect(() => {
    onCompleteRef.current = onComplete;
    dataSourceRef.current = dataSource;
  }, [onComplete, dataSource]);

  useEffect(() => {
    if (!app.ws) {
      return;
    }

    const handleMessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data?.type === messageType) {
          const { fileName, progress } = data.payload as BackupProgressUpdate;

          // 如果进度达到 100%，触发完成回调
          if (progress.percent >= 100) {
            onCompleteRef.current?.(fileName);
            return;
          }

          // 更新对应文件的进度
          onDataSourceUpdate((prevDataSource) => {
            return prevDataSource.map((item: any) => {
              if (item.name === fileName) {
                return {
                  ...item,
                  inProgress: true,
                  status: 'in_progress',
                  progress: progress.percent,
                  currentStep: progress.currentStep,
                };
              }
              return item;
            });
          });
        }
      } catch (error) {
        // 忽略解析错误
      }
    };

    app.ws.on('message', handleMessage);

    return () => {
      app.ws.off('message', handleMessage);
    };
  }, [app.ws, messageType, onDataSourceUpdate]);
}

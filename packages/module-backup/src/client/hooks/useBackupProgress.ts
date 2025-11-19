import { useCallback, useEffect, useRef } from 'react';
import { useApp } from '@tachybase/client';
import { autorun } from '@tachybase/schema';

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
  /**
   * 超时时间（毫秒），如果备份任务长时间没有收到进度更新，将被标记为失败
   * 默认为 5 分钟 (300000 毫秒)
   */
  timeout?: number;
  /**
   * 超时回调，当备份任务超时时调用
   */
  onTimeout?: (fileName: string) => void;
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
  timeout = 5 * 60 * 1000, // 默认 5 分钟
  onTimeout,
}: UseBackupProgressOptions) {
  const app = useApp();
  const onCompleteRef = useRef(onComplete);
  const onTimeoutRef = useRef(onTimeout);
  const dataSourceRef = useRef(dataSource);
  const hasSentSignInRef = useRef(false);
  // 跟踪每个备份任务的最后更新时间
  const lastUpdateTimeRef = useRef<Map<string, number>>(new Map());
  // 跟踪每个备份任务的超时定时器
  const timeoutTimersRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // 更新 ref，确保总是使用最新的值
  useEffect(() => {
    onCompleteRef.current = onComplete;
    onTimeoutRef.current = onTimeout;
    dataSourceRef.current = dataSource;
  }, [onComplete, onTimeout, dataSource]);

  // 确保 WebSocket 连接后发送 signIn 消息，设置用户标签
  // 这样服务端才能通过标签找到对应的连接并推送备份进度
  // 备份模块独立处理 signIn 消息，不依赖 message 模块
  // 即使 message 模块已加载，备份模块也会发送 signIn 以确保标签正确设置
  useEffect(() => {
    if (!app.ws || !app.ws.enabled) {
      return;
    }

    // 始终发送 signIn 消息，不依赖 message 模块
    // 备份模块的服务端会处理这个消息并设置 WebSocket 标签
    const disposer = autorun(() => {
      if (app.ws.connected && !hasSentSignInRef.current) {
        const token = app.apiClient.auth.getToken();
        if (token) {
          // 发送 signIn 消息，让服务端设置 WebSocket 标签
          // 标签格式为 app:${appName}#${userId}，服务端通过这个标签推送消息
          const data = {
            type: 'signIn',
            payload: {
              token: token,
            },
          };
          app.ws.send(JSON.stringify(data));
          hasSentSignInRef.current = true;
        }
      } else if (!app.ws.connected) {
        // 连接断开时重置标志，以便重连后再次发送
        hasSentSignInRef.current = false;
      }
    });

    return () => {
      disposer();
      hasSentSignInRef.current = false;
    };
  }, [app.ws, app.apiClient]);

  // 设置超时检测（使用 useCallback 避免闭包问题）
  const setupTimeoutCheck = useCallback(
    (fileName: string) => {
      // 清除旧的超时定时器
      const oldTimer = timeoutTimersRef.current.get(fileName);
      if (oldTimer) {
        clearTimeout(oldTimer);
      }

      // 更新最后更新时间
      lastUpdateTimeRef.current.set(fileName, Date.now());

      // 设置新的超时定时器
      const timer = setTimeout(() => {
        // 检查是否真的超时了（可能在这期间收到了更新）
        const lastUpdate = lastUpdateTimeRef.current.get(fileName);
        if (lastUpdate && Date.now() - lastUpdate >= timeout) {
          // 标记为失败
          onDataSourceUpdate((prevDataSource) => {
            return prevDataSource.map((item: any) => {
              if (item.name === fileName && (item.inProgress || item.status === 'in_progress')) {
                console.warn(`[BackupProgress] Backup task ${fileName} timed out after ${timeout}ms`);
                return {
                  ...item,
                  inProgress: false,
                  status: 'error',
                  progress: item.progress || 0,
                  currentStep: 'Timeout: No progress update received',
                };
              }
              return item;
            });
          });

          // 清理定时器和更新时间
          timeoutTimersRef.current.delete(fileName);
          lastUpdateTimeRef.current.delete(fileName);

          // 触发超时回调
          onTimeoutRef.current?.(fileName);
        }
      }, timeout);

      timeoutTimersRef.current.set(fileName, timer);
    },
    [timeout, onDataSourceUpdate],
  );

  // 清理超时检测
  const clearTimeoutCheck = useCallback((fileName: string) => {
    const timer = timeoutTimersRef.current.get(fileName);
    if (timer) {
      clearTimeout(timer);
      timeoutTimersRef.current.delete(fileName);
    }
    lastUpdateTimeRef.current.delete(fileName);
  }, []);

  // 监听数据源变化，为新的备份任务设置超时检测
  useEffect(() => {
    dataSource.forEach((item: any) => {
      if ((item.inProgress || item.status === 'in_progress') && item.name) {
        // 如果进度已经达到 100%，说明备份已完成，不应该设置超时检测
        if (item.progress >= 100) {
          // 清理可能存在的超时检测
          clearTimeoutCheck(item.name);
          return;
        }
        // 如果还没有设置超时检测，则设置
        if (!timeoutTimersRef.current.has(item.name)) {
          setupTimeoutCheck(item.name);
        }
      } else {
        // 如果任务不在进行中，清理超时检测
        if (item.name && timeoutTimersRef.current.has(item.name)) {
          clearTimeoutCheck(item.name);
        }
      }
    });
  }, [dataSource, setupTimeoutCheck, clearTimeoutCheck]);

  useEffect(() => {
    if (!app.ws) {
      return;
    }

    const handleMessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);

        if (data?.type === messageType) {
          // 检查 payload 是否存在
          if (!data.payload) {
            console.warn('[BackupProgress] Received message without payload:', data);
            return;
          }

          const { fileName, progress } = data.payload as BackupProgressUpdate;

          // 检查必要字段
          if (!fileName || !progress) {
            console.warn('[BackupProgress] Invalid message format:', data.payload);
            return;
          }

          // 如果进度达到 100%，触发完成回调并清理超时检测
          if (progress.percent >= 100) {
            clearTimeoutCheck(fileName);
            onCompleteRef.current?.(fileName);
            return;
          }

          // 更新对应文件的进度，并重置超时检测
          onDataSourceUpdate((prevDataSource) => {
            return prevDataSource.map((item: any) => {
              if (item.name === fileName) {
                // 重置超时检测
                setupTimeoutCheck(fileName);
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
      // 清理所有超时定时器
      timeoutTimersRef.current.forEach((timer) => {
        clearTimeout(timer);
      });
      timeoutTimersRef.current.clear();
      lastUpdateTimeRef.current.clear();
    };
  }, [app.ws, messageType, onDataSourceUpdate, setupTimeoutCheck, clearTimeoutCheck]);
}

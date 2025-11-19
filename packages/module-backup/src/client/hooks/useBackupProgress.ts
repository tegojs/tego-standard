import { useEffect, useRef } from 'react';
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
  const hasSentSignInRef = useRef(false);

  // 更新 ref，确保总是使用最新的值
  useEffect(() => {
    onCompleteRef.current = onComplete;
    dataSourceRef.current = dataSource;
  }, [onComplete, dataSource]);

  // 确保 WebSocket 连接后发送 signIn 消息，设置用户标签
  // 这样服务端才能通过标签找到对应的连接并推送备份进度
  // 注意：如果 message 模块已加载，MessageChannelProvider 也会发送 signIn，但不会冲突
  // 备份模块的服务端也会处理 signIn 消息，所以即使 message 模块未加载也能正常工作
  useEffect(() => {
    if (!app.ws || !app.ws.enabled) {
      return;
    }

    // 检查 message 模块是否已加载（如果已加载，MessageChannelProvider 会发送 signIn）
    // 如果 message 模块已加载，我们就不需要重复发送了
    const messagePlugin = app.pm.get('ModuleMessageClient');
    if (messagePlugin) {
      // message 模块已加载，MessageChannelProvider 会发送 signIn，这里不需要重复发送
      return;
    }

    // 如果 message 模块未加载，我们需要发送 signIn 消息
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
  }, [app.ws, app.apiClient, app.pm]);

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

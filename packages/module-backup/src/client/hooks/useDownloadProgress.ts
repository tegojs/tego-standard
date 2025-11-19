import { useCallback, useState } from 'react';
import { useAPIClient } from '@tachybase/client';

export interface UseDownloadProgressOptions {
  /**
   * 下载完成后的回调
   */
  onDownloadComplete?: (fileName: string, blob: Blob) => void;
  /**
   * 下载失败的回调
   */
  onDownloadError?: (fileName: string, error: Error) => void;
  /**
   * 下载开始时的回调（用于显示弹窗等）
   */
  onDownloadStart?: (fileName: string) => void;
}

export interface DownloadProgressState {
  [fileName: string]: number;
}

/**
 * Hook：管理文件下载进度
 *
 * @example
 * ```tsx
 * const { downloadProgress, handleDownload, clearDownloadProgress } = useDownloadProgress({
 *   onDownloadComplete: (fileName, blob) => {
 *     saveAs(blob, fileName);
 *   },
 * });
 *
 * // 在表格列中使用
 * <BackupProgressCell downloadProgress={downloadProgress[record.name]} />
 * ```
 */
export function useDownloadProgress(options?: UseDownloadProgressOptions) {
  const apiClient = useAPIClient();
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgressState>({});

  const handleDownload = useCallback(
    async (fileData: { name: string; downloadUrl?: string }) => {
      const fileName = fileData.name;

      // 初始化下载进度
      setDownloadProgress((prev) => ({ ...prev, [fileName]: 0 }));

      // 触发下载开始回调
      if (options?.onDownloadStart) {
        options.onDownloadStart(fileName);
      }

      try {
        // 使用 apiClient.request 进行下载，支持进度回调
        const response = await apiClient.request({
          url: 'backupFiles:download',
          method: 'get',
          params: {
            filterByTk: fileName,
          },
          responseType: 'blob',
          onDownloadProgress: (progressEvent) => {
            if (progressEvent.total) {
              const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
              setDownloadProgress((prev) => ({
                ...prev,
                [fileName]: percentCompleted,
              }));
            }
          },
        });

        // 下载完成
        setDownloadProgress((prev) => {
          const newState = { ...prev };
          delete newState[fileName];
          return newState;
        });

        // 触发完成回调
        // apiClient.request 返回的数据结构可能是 { data: blob } 或直接是 blob
        const blob = response?.data || response;
        if (options?.onDownloadComplete) {
          options.onDownloadComplete(fileName, blob);
        }
      } catch (error) {
        // 下载失败，清除进度
        setDownloadProgress((prev) => {
          const newState = { ...prev };
          delete newState[fileName];
          return newState;
        });

        // 触发错误回调
        if (options?.onDownloadError) {
          options.onDownloadError(fileName, error as Error);
        } else {
          throw error;
        }
      }
    },
    [apiClient, options],
  );

  const clearDownloadProgress = useCallback((fileName?: string) => {
    if (fileName) {
      setDownloadProgress((prev) => {
        const newState = { ...prev };
        delete newState[fileName];
        return newState;
      });
    } else {
      setDownloadProgress({});
    }
  }, []);

  return {
    downloadProgress,
    handleDownload,
    clearDownloadProgress,
  };
}

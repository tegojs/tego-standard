import React, { useEffect, useRef, useState } from 'react';
import { Icon, useAPIClient } from '@tachybase/client';
import { useForm } from '@tachybase/schema';

import { Button, message, Typography } from 'antd';

import { lang } from '../../locale';

const { Text } = Typography;

// 按钮样式常量
const BUTTON_COLORS = {
  primary: '#52c41a',
  hover: '#73d13d',
} as const;

/**
 * 同步远程代码按钮（用于工作流脚本节点）
 * 从远程地址获取代码并填充到代码编辑器中
 */
export const SyncRemoteCodeButton: React.FC = () => {
  const form = useForm();
  const apiClient = useAPIClient();
  const [loading, setLoading] = useState(false);
  const [isSynced, setIsSynced] = useState(false);
  const syncedCodeRef = useRef<string | null>(null);
  const autoSyncedRef = useRef(false); // 标记是否已经自动同步过

  const codeSource = form.values?.codeSource;
  const codeType = form.values?.codeType;
  const codeUrl = form.values?.codeUrl;
  const currentCode = form.values?.code || '';

  // 同步函数（支持静默模式）
  const syncCode = React.useCallback(
    async (silent = false) => {
      const values = form.values || {};
      const {
        codeSource: syncCodeSource,
        codeType: syncCodeType,
        codeUrl: syncCodeUrl,
        codeBranch = 'main',
        codeAuthType = 'token',
        codeAuthToken,
        codeAuthUsername,
      } = values;

      // 验证必填字段
      if (syncCodeSource !== 'remote' || !syncCodeType || !syncCodeUrl) {
        return;
      }

      if (!silent) {
        setLoading(true);
      }
      try {
        const response = await apiClient.request({
          resource: 'flow_nodes',
          action: 'syncRemoteCode',
          params: {
            values: {
              codeUrl: syncCodeUrl,
              codeType: syncCodeType,
              codeBranch: syncCodeType === 'git' ? codeBranch : undefined,
              codeAuthType,
              codeAuthToken,
              codeAuthUsername,
            },
          },
        });

        // 响应格式可能是 response.data 或 response.data.data
        const remoteCode = response?.data?.code || response?.data?.data?.code;
        if (remoteCode) {
          // 将远程代码填充到代码字段
          form.setValues({
            ...form.values,
            code: remoteCode,
          });
          // 记录同步的代码内容
          syncedCodeRef.current = remoteCode;
          setIsSynced(true);
          if (!silent) {
            message.success(lang('Code synced successfully'));
          }
        } else {
          if (!silent) {
            message.error(lang('No code returned from remote source'));
          }
        }
      } catch (error: unknown) {
        // 静默模式下只记录错误，不显示消息
        if (!silent) {
          const errorMessage =
            (error as { response?: { data?: { error?: { message?: string } } }; message?: string })?.response?.data
              ?.error?.message ||
            (error as { message?: string })?.message ||
            lang('Failed to sync remote code');
          message.error(errorMessage);
        }
      } finally {
        if (!silent) {
          setLoading(false);
        }
      }
    },
    [form, apiClient],
  );

  const handleSync = async () => {
    // 从表单获取最新值
    const currentValues = form.values || {};
    const currentCodeSource = currentValues.codeSource;
    const currentCodeType = currentValues.codeType;
    const currentCodeUrl = currentValues.codeUrl;

    // 验证必填字段
    if (currentCodeSource !== 'remote') {
      message.warning(lang('Please select remote code source first'));
      return;
    }

    if (!currentCodeType) {
      message.warning(lang('Please select code type first'));
      return;
    }

    if (!currentCodeUrl || !currentCodeUrl.trim()) {
      message.warning(lang('Code URL is required for Git'));
      return;
    }

    await syncCode(false);
  };

  // 检查同步状态：比较当前代码和最后一次同步的代码
  useEffect(() => {
    if (syncedCodeRef.current !== null) {
      // 如果当前代码与同步的代码一致，则标记为已同步
      setIsSynced(currentCode === syncedCodeRef.current);
    } else {
      // 如果没有同步记录，默认为未同步
      setIsSynced(false);
    }
  }, [currentCode]);

  // 弹窗打开时自动静默同步远程代码
  useEffect(() => {
    // 当表单值加载完成且满足同步条件时，自动执行静默同步
    if (codeSource === 'remote' && codeType && codeUrl && !autoSyncedRef.current) {
      // 延迟执行，确保表单数据已完全加载
      const timer = setTimeout(() => {
        autoSyncedRef.current = true;
        syncCode(true);
      }, 300);

      return () => {
        clearTimeout(timer);
      };
    }
  }, [codeSource, codeType, codeUrl, syncCode]);

  // 当表单重置时（如关闭弹窗后重新打开），重置自动同步标记
  useEffect(() => {
    if (!codeSource || codeSource !== 'remote') {
      autoSyncedRef.current = false;
    }
  }, [codeSource]);

  // 只在远程代码且已选择代码类型时显示按钮
  if (codeSource !== 'remote' || !codeType) {
    return null;
  }

  return (
    <div style={{ marginBottom: 8 }}>
      <Button
        type="primary"
        icon={<Icon type="SyncOutlined" />}
        loading={loading}
        onClick={handleSync}
        style={{
          backgroundColor: BUTTON_COLORS.primary,
          borderColor: BUTTON_COLORS.primary,
          marginBottom: 4,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = BUTTON_COLORS.hover;
          e.currentTarget.style.borderColor = BUTTON_COLORS.hover;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = BUTTON_COLORS.primary;
          e.currentTarget.style.borderColor = BUTTON_COLORS.primary;
        }}
      >
        {lang('Sync remote code')}
      </Button>
      <div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {lang('Sync status')}:{' '}
          <Text type={isSynced ? 'success' : 'warning'}>{isSynced ? lang('Synced') : lang('Not synced')}</Text>
        </Text>
      </div>
    </div>
  );
};

import React, { useEffect, useRef, useState } from 'react';
import { css, useApp } from '@tachybase/client';

import { Button } from 'antd';
import { ErrorBoundary, FallbackProps } from 'react-error-boundary';

import { CloudComponentModule } from '../../types';
import { useTranslation } from '../locale';

export const createId = (name: string, len: number = 10) => {
  return (
    name +
    '_' +
    Number(Math.random().toString().substring(2, 12) + Date.now())
      .toString(36)
      .slice(0, len)
  );
};

/**
 * 组件预览
 */
function ComPreview({ compileCode }: { compileCode: string }) {
  const [Component, setComponent] = useState<React.ComponentType<{ id?: string }> | null>(null);
  const [compileError, setCompileError] = useState('');
  const { t } = useTranslation();
  const app = useApp();
  const blobUrlRef = useRef<string | null>(null);

  // 加载模块
  const loadModule = async () => {
    if (!compileCode) {
      setComponent(null);
      setCompileError('');
      return;
    }

    // 清理之前的 Blob URL
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }

    // 编译后的代码，通过Blob对象来创建URL
    const blob = new Blob([compileCode], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    blobUrlRef.current = url;

    try {
      app.requirejs.require(
        [url],
        function (myModule: CloudComponentModule) {
          setComponent(() => myModule?.default || null);
          setCompileError('');
        },
        function (err: Error) {
          const errorMessage = err?.message || String(err) || t('Failed to load module');
          setCompileError(errorMessage);
          // 开发环境下输出详细错误信息
          if (process.env.NODE_ENV === 'development') {
            console.error('[CloudComponent] 模块加载失败:', err);
          }
        },
      );
    } catch (error: unknown) {
      const errorMessage = (error instanceof Error ? error.message : String(error)) || t('Failed to load module');
      setCompileError(errorMessage);
      // 开发环境下输出详细错误信息
      if (process.env.NODE_ENV === 'development') {
        console.error('[CloudComponent] 模块加载失败:', error);
      }
    }
  };

  useEffect(() => {
    loadModule();

    // 清理函数：组件卸载时释放 Blob URL
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [compileCode]);

  const id = createId('CPreview');
  return (
    <div
      className={css`
        padding: 20px;
        height: 800px;
        overflow: auto;
      `}
    >
      <ErrorBoundary
        fallbackRender={({ error, resetErrorBoundary }: FallbackProps) => (
          <div>
            <h2>{t('Ooops.')}</h2>
            <p style={{ lineHeight: '30px', color: 'red' }}>{error.message}</p>
            <Button type="primary" onClick={resetErrorBoundary}>
              {t('Try again')}
            </Button>
          </div>
        )}
      >
        {!compileError && Component && <Component id={id} />}
        {compileError && (
          <div>
            <h2>{t('Ooops.')}</h2>
            <p style={{ lineHeight: '30px', color: 'red' }}>{compileError}</p>
          </div>
        )}
      </ErrorBoundary>
    </div>
  );
}

export default ComPreview;

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { css } from '@tachybase/client';
import { connect, useForm } from '@tachybase/schema';
import { CodeEditor } from '@tego/client';

import { Alert, Input } from 'antd';

import { tval } from '../../locale';

const { TextArea } = Input;

// Monaco Editor 类型定义
interface MonacoEditor {
  deltaDecorations?: (oldDecorations: any[], newDecorations: any[]) => any[];
  getModel?: () => { getLineLength: (lineNumber: number) => number } | null;
  revealLineInCenter?: (lineNumber: number) => void;
  updateOptions?: (options: any) => void;
  [key: string]: any; // 允许访问其他 Monaco Editor 属性
}

/**
 * 工作流脚本节点的代码编辑器
 * 支持自动补全和远程代码同步
 *
 * 注意：Monaco Editor 的资源加载配置由 desktop 应用的 preload 脚本处理
 * 如果 Monaco Editor 无法加载，会自动降级到 TextArea 以确保功能可用
 */
export const ScriptCodeEditor = connect(({ value: code, onChange: setCode, ...others }) => {
  const form = useForm();
  const editorRef = useRef<MonacoEditor | null>(null);
  const [editorError, setEditorError] = useState<Error | null>(null);
  const [useFallback, setUseFallback] = useState(false);
  const [loadingTimeout, setLoadingTimeout] = useState<NodeJS.Timeout | null>(null);

  // 检查代码来源，如果是远程代码则设置为只读
  const codeSource = form.values?.codeSource;
  const isReadOnly = codeSource === 'remote';

  // 检测编辑器是否成功加载，如果超时则降级
  useEffect(() => {
    // 设置超时检测：如果 5 秒后编辑器仍未加载，降级到 TextArea
    const timeout = setTimeout(() => {
      if (!editorRef.current && !useFallback) {
        console.warn('[ScriptCodeEditor] Monaco Editor failed to load within timeout, using fallback TextArea');
        setUseFallback(true);
      }
    }, 5000);

    setLoadingTimeout(timeout);

    return () => {
      if (timeout) {
        clearTimeout(timeout);
      }
    };
  }, [useFallback]);

  // 编辑器成功挂载时清除超时
  const handleEditorMount = useCallback(
    (editor: any) => {
      if (loadingTimeout) {
        clearTimeout(loadingTimeout);
        setLoadingTimeout(null);
      }
      editorRef.current = editor;
      setEditorError(null);
      setUseFallback(false);
    },
    [loadingTimeout],
  );

  // 使用 useMemo 创建响应式的编辑器选项
  const editorOptions = useMemo(
    () => ({
      lineNumbers: 'on' as const,
      minimap: {
        enabled: false,
      },
      readOnly: isReadOnly, // 远程代码时设置为只读
      // 自动补全配置（仅在本地代码模式下启用）
      quickSuggestions: !isReadOnly
        ? {
            other: true,
            comments: true,
            strings: true,
          }
        : false,
      suggestOnTriggerCharacters: !isReadOnly,
      acceptSuggestionOnCommitCharacter: !isReadOnly,
      acceptSuggestionOnEnter: (!isReadOnly ? 'on' : 'off') as 'on' | 'off',
      tabCompletion: (!isReadOnly ? 'on' : 'off') as 'on' | 'off',
      wordBasedSuggestions: (!isReadOnly ? 'allDocuments' : 'off') as 'allDocuments' | 'off',
      snippetSuggestions: (!isReadOnly ? 'top' : 'none') as 'top' | 'none',
      // 其他编辑器增强功能
      autoIndent: (!isReadOnly ? 'full' : 'none') as 'full' | 'none',
      formatOnPaste: !isReadOnly,
      formatOnType: !isReadOnly,
      codeLens: !isReadOnly,
      folding: true,
      bracketPairColorization: {
        enabled: !isReadOnly,
      },
      // TypeScript 自动补全配置
      suggest: {
        showKeywords: !isReadOnly,
        showSnippets: !isReadOnly,
        showClasses: !isReadOnly,
        showFunctions: !isReadOnly,
        showVariables: !isReadOnly,
        showModules: !isReadOnly,
        showProperties: !isReadOnly,
        showReferences: !isReadOnly,
        showValues: !isReadOnly,
        showEnums: !isReadOnly,
        showEnumMembers: !isReadOnly,
        showEvents: !isReadOnly,
        showOperators: !isReadOnly,
        showUnits: !isReadOnly,
        showColors: !isReadOnly,
        showFiles: !isReadOnly,
        showTypeParameters: !isReadOnly,
        showIssues: !isReadOnly,
        showUsers: !isReadOnly,
        showFolders: !isReadOnly,
      },
    }),
    [isReadOnly],
  );

  // 监听 codeSource 变化，动态更新编辑器的只读状态
  useEffect(() => {
    const editor = editorRef.current;
    if (editor) {
      // 尝试使用 updateOptions 方法（Monaco Editor 的标准方法）
      if (typeof editor.updateOptions === 'function') {
        editor.updateOptions(editorOptions);
      } else {
        // 如果 updateOptions 不存在，尝试直接访问编辑器实例
        const monacoEditor = (editor as any).getEditor?.() || editor;
        if (monacoEditor && typeof monacoEditor.updateOptions === 'function') {
          monacoEditor.updateOptions(editorOptions);
        }
      }
    }
  }, [codeSource, isReadOnly, editorOptions]);

  // 处理代码变化
  const handleChange = (value: string = '') => {
    if (isReadOnly) {
      return; // 只读模式下不允许修改
    }
    setCode(value);
  };

  // 处理编辑器错误
  const handleEditorError = useCallback((error: Error) => {
    console.error('[ScriptCodeEditor] Monaco Editor error:', error);
    setEditorError(error);
    setUseFallback(true);
  }, []);

  // 如果使用降级方案，显示 TextArea
  if (useFallback || editorError) {
    const height = others.height || '50vh';
    const heightValue = typeof height === 'string' ? height : `${height}px`;

    return (
      <div
        className={css`
          display: flex;
          flex-direction: column;
          height: ${heightValue};
        `}
      >
        {editorError && (
          <Alert
            message={tval('Code editor failed to load')}
            description={tval(
              'Monaco Editor failed to load, downgraded to basic text editor. Some features may be limited.',
            )}
            type="warning"
            showIcon
            closable
            onClose={() => setEditorError(null)}
            className={css`
              margin-bottom: 8px;
            `}
          />
        )}
        <TextArea
          value={code || ''}
          onChange={(e) => handleChange(e.target.value)}
          readOnly={isReadOnly}
          placeholder={tval('Please enter code...')}
          style={{
            height: `calc(${heightValue} - ${editorError ? '60px' : '0px'})`,
            fontFamily: 'Consolas, Monaco, "Andale Mono", "Ubuntu Mono", monospace',
            fontSize: '14px',
            lineHeight: '1.5',
            resize: 'none',
          }}
          {...others}
        />
      </div>
    );
  }

  // 监听全局错误，捕获 Monaco Editor 加载失败
  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      // 检查是否是 Monaco Editor 相关的错误
      if (
        event.message?.includes('monaco') ||
        event.message?.includes('Monaco') ||
        event.filename?.includes('monaco') ||
        event.filename?.includes('vs/') ||
        event.filename?.includes('loader.js')
      ) {
        console.warn('[ScriptCodeEditor] Detected Monaco Editor error, will use fallback:', event.message);
        setUseFallback(true);
      }
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const errorMessage = reason?.message || String(reason);
      if (errorMessage.includes('monaco') || errorMessage.includes('Monaco') || errorMessage.includes('loader')) {
        console.warn('[ScriptCodeEditor] Detected Monaco Editor promise rejection, will use fallback:', errorMessage);
        setUseFallback(true);
      }
    };

    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);

    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    };
  }, []);

  // 使用 Monaco Editor
  return (
    <CodeEditor
      defaultLanguage="typescript"
      value={code}
      onChange={handleChange}
      options={editorOptions}
      height={others.height || '50vh'}
      onMount={handleEditorMount}
      loading={
        <div
          className={css`
            display: flex;
            align-items: center;
            justify-content: center;
            height: ${typeof others.height === 'string' ? others.height : others.height || '50vh'};
            color: #999;
          `}
        >
          {tval('Loading editor...')}
        </div>
      }
      {...others}
    />
  );
});

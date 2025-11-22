import React, { useEffect, useMemo, useRef } from 'react';
import { connect, useForm } from '@tachybase/schema';
import { CodeEditor } from '@tego/client';

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
 */
export const ScriptCodeEditor = connect(({ value: code, onChange: setCode, ...others }) => {
  const form = useForm();
  const editorRef = useRef<MonacoEditor | null>(null);

  // 检查代码来源，如果是远程代码则设置为只读
  const codeSource = form.values?.codeSource;
  const isReadOnly = codeSource === 'remote';

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

  return (
    <CodeEditor
      defaultLanguage="typescript"
      value={code}
      onChange={handleChange}
      options={editorOptions}
      height={others.height || '50vh'}
      onMount={(editor) => (editorRef.current = editor)}
      {...others}
    />
  );
});

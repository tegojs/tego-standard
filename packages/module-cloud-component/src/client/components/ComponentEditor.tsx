import React, { useEffect, useRef, useState } from 'react';
import { css } from '@tachybase/client';
import { connect } from '@tachybase/schema';
import { CodeEditor } from '@tego/client';

import * as Babel from '@babel/standalone';
import { useDebounceFn, useKeyPress } from 'ahooks';
import { Spin, Splitter } from 'antd';
import parserJavaScript from 'prettier/plugins/babel';
import prettierPluginEstree from 'prettier/plugins/estree';
import * as prettier from 'prettier/standalone';

import { CompileCache, CompileError } from '../../types';
import { useTranslation } from '../locale';
import ComPreview from './Preview';

export default connect(({ value: code, onChange: setCode }) => {
  const { t } = useTranslation();
  const [compileCode, setCompileCode] = useState('');
  const [error, setError] = useState<CompileError | null>(null);
  const [loading, setLoading] = useState(true);
  // Monaco Editor 类型定义
  interface MonacoEditor {
    deltaDecorations?: (oldDecorations: any[], newDecorations: any[]) => any[];
    getModel?: () => { getLineLength: (lineNumber: number) => number } | null;
    revealLineInCenter?: (lineNumber: number) => void;
  }

  const editorRef = useRef<MonacoEditor | null>(null);
  // 编译缓存：避免重复编译相同代码
  const compileCacheRef = useRef<CompileCache | null>(null);

  // 保存后，格式化代码
  useKeyPress(['meta.s', 'ctrl.s'], async (event) => {
    try {
      event.stopPropagation();
      event.preventDefault();
      const formatted = await prettier.format(code, {
        parser: 'babel',
        plugins: [parserJavaScript, prettierPluginEstree],
        useTabs: false,
        tabWidth: 2, // tab对应空格数
        printWidth: 80,
        semi: true,
        singleQuote: true,
        trailingComma: 'es5', // 尾随逗号
        bracketSpacing: true, // 在对象文字中的括号之间打印空格，如{ foo: bar }
        bracketSameLine: false, // 多行 HTML 标签开头的 > 放在最后一行的末尾而不是单独放在下一行
        arrowParens: 'always', // 在唯一的箭头函数参数周围包含括号
        endOfLine: 'auto', // 行尾风格
      });
      setCode(formatted);
      setError(null);
    } catch (error: unknown) {
      const parsedError = parseBabelError(error);
      setError(parsedError);
      markErrorInEditor(parsedError);
      if (process.env.NODE_ENV === 'development') {
        console.error('[ComponentEditor] Format error:', error);
      }
    }
  });

  // 实时保存代码
  const onChange = (value: string = '') => {
    setCode(value);
  };

  // 解析 Babel 错误信息
  const parseBabelError = (error: unknown): CompileError => {
    const err = error as { message?: string; loc?: { line?: number; column?: number } };
    const errorMessage: CompileError = {
      message: err?.message || String(error),
      rawMessage: err?.message || String(error),
    };

    // 尝试从错误信息中提取行号和列号
    if (err?.loc) {
      errorMessage.line = err.loc.line;
      errorMessage.column = err.loc.column;
    } else if (err?.message) {
      // 尝试从错误消息中解析行号 (例如: "Unexpected token (5:10)")
      const lineMatch = err.message.match(/\((\d+):(\d+)\)/);
      if (lineMatch) {
        errorMessage.line = parseInt(lineMatch[1], 10);
        errorMessage.column = parseInt(lineMatch[2], 10);
      }
    }

    // 格式化错误消息
    if (errorMessage.line && errorMessage.column) {
      errorMessage.message =
        t('Location: Line {line}, Column {column}', {
          line: errorMessage.line,
          column: errorMessage.column,
        }) + `: ${errorMessage.rawMessage}`;
    } else if (errorMessage.line) {
      errorMessage.message =
        t('Location: Line {line}', {
          line: errorMessage.line,
        }) + `: ${errorMessage.rawMessage}`;
    }

    return errorMessage;
  };

  // 在编辑器中标记错误位置
  const markErrorInEditor = (error: CompileError) => {
    if (!editorRef.current || !error.line) return;

    try {
      const editor = editorRef.current;
      const monaco = (window as any).monaco;

      if (monaco && editor.getModel) {
        const model = editor.getModel();
        if (model) {
          // 清除之前的标记
          const decorations = editor.deltaDecorations([], []);

          // 添加新的错误标记
          const lineNumber = error.line;
          const column = error.column || 1;
          const endColumn = model.getLineLength(lineNumber) + 1;

          editor.deltaDecorations(decorations, [
            {
              range: new monaco.Range(lineNumber, column, lineNumber, endColumn),
              options: {
                isWholeLine: !error.column,
                className: 'error-line',
                glyphMarginClassName: 'error-glyph',
                hoverMessage: { value: error.rawMessage || error.message },
              },
            },
          ]);

          // 跳转到错误行
          editor.revealLineInCenter(lineNumber);
        }
      }
    } catch (e) {
      // 如果编辑器 API 不可用，忽略
      if (process.env.NODE_ENV === 'development') {
        console.warn('[ComponentEditor] Failed to mark error in editor:', e);
      }
    }
  };

  // 编译代码（带缓存）
  const handleCompile = async () => {
    if (!code) {
      setCompileCode('');
      setError(null);
      setLoading(false);
      compileCacheRef.current = null;
      return;
    }

    // 检查缓存
    if (compileCacheRef.current && compileCacheRef.current.code === code) {
      setCompileCode(compileCacheRef.current.result);
      setError(null);
      setLoading(false);
      return;
    }

    try {
      const result = Babel.transform(code, {
        filename: 'file.tsx',
        presets: [['env', { modules: 'amd' }], 'react', 'typescript'],
      });

      if (!result || !result.code) {
        throw new Error(t('Compilation failed: No code generated'));
      }

      // 更新缓存
      compileCacheRef.current = {
        code,
        result: result.code,
        timestamp: Date.now(),
      };

      setLoading(false);
      setCompileCode(result.code);
      setError(null);

      // 清除编辑器中的错误标记
      if (editorRef.current) {
        try {
          const editor = editorRef.current;
          if (editor.deltaDecorations) {
            editor.deltaDecorations([], []);
          }
        } catch (e) {
          // 忽略
        }
      }
    } catch (error: unknown) {
      const parsedError = parseBabelError(error);
      setError(parsedError);
      setLoading(false);
      // 清除缓存（编译失败）
      compileCacheRef.current = null;

      // 在编辑器中标记错误
      markErrorInEditor(parsedError);

      if (process.env.NODE_ENV === 'development') {
        console.error('[ComponentEditor] Compilation error:', error);
      }
    }
  };

  // 使用防抖的编译函数
  const { run: debouncedCompile } = useDebounceFn(handleCompile, {
    wait: 800, // 800ms 防抖延迟
    leading: false,
    trailing: true,
  });

  // 监听代码变化，触发防抖编译
  useEffect(() => {
    setLoading(true);
    debouncedCompile();
  }, [code]);

  const { run } = useDebounceFn(onChange, { wait: 500 });

  return (
    <div
      className={css`
        height: 480px;
      `}
    >
      <Splitter>
        <Splitter.Panel defaultSize="50%">
          <CodeEditor
            defaultLanguage="typescript"
            value={code}
            onChange={(value) => {
              setLoading(true);
              run(value);
            }}
            options={{
              lineNumbers: 'on',
              minimap: {
                enabled: false,
              },
            }}
            height="100%"
            onMount={(editor) => (editorRef.current = editor)}
          />
        </Splitter.Panel>
        <Splitter.Panel defaultSize="50%">
          <Spin spinning={loading} tip={t('Compiling...')}>
            {error ? (
              <div
                style={{
                  padding: '20px',
                  backgroundColor: '#fff2f0',
                  border: '1px solid #ffccc7',
                  borderRadius: '4px',
                  margin: '20px',
                }}
              >
                <h3 style={{ color: '#ff4d4f', marginTop: 0, marginBottom: '12px' }}>{t('Compilation error')}</h3>
                <p style={{ color: '#ff4d4f', lineHeight: '24px', margin: 0, whiteSpace: 'pre-wrap' }}>
                  {error.message}
                </p>
                {error.line && (
                  <p style={{ color: '#8c8c8c', fontSize: '12px', marginTop: '8px', marginBottom: 0 }}>
                    {error.column
                      ? t('Location: Line {line}, Column {column}', {
                          line: error.line,
                          column: error.column,
                        })
                      : t('Location: Line {line}', { line: error.line })}
                  </p>
                )}
              </div>
            ) : (
              <ComPreview compileCode={compileCode} />
            )}
          </Spin>
        </Splitter.Panel>
      </Splitter>
    </div>
  );
});

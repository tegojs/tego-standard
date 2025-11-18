import { useMemo } from 'react';
import { useExpressionScope } from '@tachybase/schema';

import { useCompile } from '../../../hooks';
import { useA } from '../hooks';

/**
 * 编译 useAction，支持函数和字符串引用两种形式
 * @param useAction - 可以是函数或字符串引用（如 '{{ useRevisionAction }}'）
 * @param actionCallback - 传递给 useAction 的回调函数
 * @returns 编译后的 useAction hook 的返回值 { run, element }
 */
export const useCompiledAction = (useAction: any, actionCallback?: any) => {
  const compile = useCompile();
  const scope = useExpressionScope();

  const compiledUseAction = useMemo(() => {
    // 如果已经是函数，直接返回
    if (typeof useAction === 'function') {
      return useAction;
    }

    // 如果是字符串引用，需要编译
    if (typeof useAction === 'string' && useAction.startsWith('{{')) {
      // 提取字符串引用中的表达式，例如 "{{ useRevisionAction }}" -> "useRevisionAction"
      const match = useAction.match(/\{\{\s*([^}]+)\s*\}\}/);
      if (match && match[1]) {
        const expression = match[1].trim();
        // 从 scope 中获取函数
        const func = scope[expression];
        if (typeof func === 'function') {
          return func;
        }
        // 如果 scope 中没有，尝试编译
        const compiled = compile(useAction);
        if (typeof compiled === 'function') {
          return compiled;
        }
        console.warn(`useAction not found in scope or compilation failed: ${expression}`, scope);
        return useA;
      }
      // 如果匹配失败，尝试直接编译
      const compiled = compile(useAction);
      if (typeof compiled === 'function') {
        return compiled;
      }
      console.warn(`useAction compilation failed: ${useAction}`, compiled);
      return useA;
    }

    // 如果不是函数也不是字符串引用，使用默认值
    console.warn(`useAction is not a function or string reference:`, useAction);
    return useA;
  }, [useAction, compile, scope]);

  return compiledUseAction(actionCallback);
};

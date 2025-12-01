import React, { useEffect, useRef, useState } from 'react';
import { useForm } from '@tachybase/schema';

import { Button } from 'antd';

import { useTranslation } from '../locale';

// 全局编译函数（因为一个表单通常只有一个 ComponentEditor，使用固定 key）
let globalCompileFunction: (() => void) | null = null;

/**
 * 注册编译函数
 */
export const registerCompileFunction = (fn: () => void) => {
  globalCompileFunction = fn;
  return () => {
    globalCompileFunction = null;
  };
};

/**
 * 编译按钮组件
 * 仅在本地代码模式下显示
 */
export const CompileButton: React.FC = () => {
  const { t } = useTranslation();
  const form = useForm();
  const [compileFn, setCompileFn] = useState<(() => void) | null>(null);

  const codeSource = form.values?.codeSource;
  const isLocalCode = codeSource === 'local' || !codeSource;

  // 获取编译函数
  useEffect(() => {
    setCompileFn(globalCompileFunction);
    // 定期检查编译函数是否已注册（因为 ComponentEditor 可能稍后加载）
    const interval = setInterval(() => {
      if (globalCompileFunction && !compileFn) {
        setCompileFn(globalCompileFunction);
      }
    }, 100);

    return () => {
      clearInterval(interval);
    };
  }, [compileFn]);

  // 仅在本地代码模式下显示
  if (!isLocalCode || !compileFn) {
    return null;
  }

  return (
    <Button onClick={compileFn} type="default">
      {t('Compile')}
    </Button>
  );
};

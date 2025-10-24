import React from 'react';
import { Input } from '@tachybase/client';
import { connect, mapProps, mapReadPretty } from '@tachybase/schema';

// 格式化银行卡号：每4位一组，最长21位（最后一组为5位）
const formatBankCard = (value: string): string => {
  if (!value) return '';

  // 移除所有非数字字符
  const digits = value.replace(/\D/g, '');

  // 限制最长21位
  const limited = digits.slice(0, 21);

  // 格式化为 4-4-4-4-5 的形式
  const parts: string[] = [];
  for (let i = 0; i < limited.length; i += 4) {
    parts.push(limited.slice(i, i + 4));
  }

  return parts.join(' ');
};

// 解析格式化的银行卡号为纯数字
const parseBankCard = (value: string): string => {
  if (!value) return '';
  return value.replace(/\s/g, '');
};

const BankCardInputInner = (props: any) => {
  const { value, onChange, ...rest } = props;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const inputValue = e.target.value;
    const parsed = parseBankCard(inputValue);
    const formatted = formatBankCard(parsed);

    // 更新输入框显示
    e.target.value = formatted;

    // 回调时传递纯数字（不包含空格）
    onChange?.(parsed);
  };

  // 处理复制事件，复制时只复制纯数字
  const handleCopy = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const selection = window.getSelection();
    if (selection) {
      const selectedText = selection.toString();
      // 移除选中文本中的空格
      const cleanText = selectedText.replace(/\s/g, '');
      e.clipboardData.setData('text/plain', cleanText);
    }
  };

  return (
    <Input
      {...rest}
      value={formatBankCard(value)}
      onChange={handleChange}
      onCopy={handleCopy}
      placeholder={rest.placeholder || '请输入银行卡号'}
      maxLength={25} // 21个数字 + 4个空格
    />
  );
};

const BankCardReadPretty = (props: any) => {
  const { value } = props;

  // 处理只读模式下的复制事件
  const handleCopy = (e: React.ClipboardEvent<HTMLSpanElement>) => {
    e.preventDefault();
    const selection = window.getSelection();
    if (selection) {
      const selectedText = selection.toString();
      // 移除选中文本中的空格
      const cleanText = selectedText.replace(/\s/g, '');
      e.clipboardData.setData('text/plain', cleanText);
    }
  };

  return (
    <span onCopy={handleCopy} style={{ userSelect: 'text' }}>
      {formatBankCard(value)}
    </span>
  );
};

export const BankCardInput = connect(
  BankCardInputInner,
  mapProps((props, field) => {
    return {
      ...props,
    };
  }),
  mapReadPretty(BankCardReadPretty),
);

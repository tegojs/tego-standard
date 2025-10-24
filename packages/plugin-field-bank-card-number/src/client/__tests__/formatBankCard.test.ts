import { describe, expect, it } from 'vitest';

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

describe('Bank Card Formatting', () => {
  it('should format 16-digit card number', () => {
    expect(formatBankCard('6222000000000000')).toBe('6222 0000 0000 0000');
  });

  it('should format 19-digit card number', () => {
    expect(formatBankCard('6222000000000000000')).toBe('6222 0000 0000 0000 000');
  });

  it('should format 21-digit card number (4-4-4-4-5)', () => {
    expect(formatBankCard('622200000000000000012')).toBe('6222 0000 0000 0000 00012');
    expect(formatBankCard('123456789012345678901').length).toBe(25); // 21 digits + 4 spaces
  });

  it('should limit to 21 digits', () => {
    expect(formatBankCard('12345678901234567890123456')).toBe('1234 5678 9012 3456 78901');
  });

  it('should remove non-digit characters', () => {
    expect(formatBankCard('6222-0000-0000-0000')).toBe('6222 0000 0000 0000');
    expect(formatBankCard('6222 0000 0000 0000')).toBe('6222 0000 0000 0000');
  });

  it('should handle empty string', () => {
    expect(formatBankCard('')).toBe('');
  });

  it('should parse formatted card number', () => {
    expect(parseBankCard('6222 0000 0000 0000')).toBe('6222000000000000');
  });

  it('should handle partial input', () => {
    expect(formatBankCard('622')).toBe('622');
    expect(formatBankCard('6222')).toBe('6222');
    expect(formatBankCard('62220')).toBe('6222 0');
    expect(formatBankCard('622200000')).toBe('6222 0000 0');
  });
});

// 定义正则表达式, 检测形如 2024-07-04T04:46:27.166Z 的UTC时间字符串
const utcRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// 检测是否是UTC时间字符串
export function isUTCString(str = '') {
  return utcRegex.test(str);
}

// 检测是否是日期类型
export function isDateType(value: any): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  // 检查是否是UTC时间字符串
  if (isUTCString(value)) {
    return true;
  }
  // 检查是否是其他常见的日期格式
  const dateRegex = /^\d{4}-\d{2}-\d{2}/;
  if (dateRegex.test(value)) {
    // 尝试解析为日期，如果能解析且有效，则认为是日期
    const date = new Date(value);
    return !isNaN(date.getTime());
  }
  return false;
}

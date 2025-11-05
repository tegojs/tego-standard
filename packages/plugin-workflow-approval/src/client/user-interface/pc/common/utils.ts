// 定义正则表达式, 检测形如 2024-07-04T04:46:27.166Z 的UTC时间字符串
const utcRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// 检测是否是UTC时间字符串
export function isUTCString(str = '') {
  return utcRegex.test(str);
}

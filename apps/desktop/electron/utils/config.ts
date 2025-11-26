/**
 * Electron 应用配置常量
 * 统一管理应用配置，避免在多个文件中重复定义
 */

/**
 * 默认后端 API 服务器端口
 * 使用 30000 避免与常用端口（如 3000）冲突
 */
export const DEFAULT_APP_PORT = '30000';

/**
 * 默认 Web 开发服务器端口
 */
export const DEFAULT_WEB_PORT = '31000';

/**
 * 获取后端 API 服务器端口
 * 优先使用环境变量 APP_PORT，否则使用默认值
 */
export function getAppPort(): string {
  return process.env.APP_PORT || DEFAULT_APP_PORT;
}

/**
 * 获取 Web 开发服务器端口
 * 优先使用环境变量 WEB_PORT 或 PORT，否则使用默认值
 */
export function getWebPort(): string {
  return process.env.WEB_PORT || process.env.PORT || DEFAULT_WEB_PORT;
}

/**
 * 获取后端 API 服务器端口（数字类型）
 */
export function getAppPortNumber(): number {
  return parseInt(getAppPort(), 10);
}

/**
 * 获取 Web 开发服务器端口（数字类型）
 */
export function getWebPortNumber(): number {
  return parseInt(getWebPort(), 10);
}

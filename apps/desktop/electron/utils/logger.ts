import * as fs from 'node:fs';
import * as path from 'node:path';

import { app } from 'electron';

// 判断是否为开发环境（延迟评估，确保 app.isPackaged 已正确初始化）
function isDev(): boolean {
  return process.env.NODE_ENV === 'development' || !app.isPackaged;
}

// ANSI 颜色代码（原生支持，不依赖外部库）
const ANSI_COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
} as const;

// 延迟加载 chalk（如果可用则使用，否则使用原生 ANSI 代码）
let chalk: typeof import('chalk') | null = null;
let chalkLoaded = false;

function getChalk(): typeof import('chalk') | null {
  if (chalkLoaded) {
    return chalk;
  }
  chalkLoaded = true;

  // 在开发环境或输出到控制台时尝试加载 chalk
  // 检查是否输出到 TTY（终端）且未禁用颜色
  const isTTY = process.stdout.isTTY && process.stderr.isTTY;
  const noColor = process.env.NO_COLOR !== undefined || process.env.FORCE_COLOR === '0';
  // 开发环境或生产环境的 TTY 输出都可以使用颜色（除非明确禁用）
  const shouldUseColor = !noColor && (isDev() || isTTY);

  if (shouldUseColor) {
    try {
      chalk = require('chalk');
    } catch {
      // chalk 不可用时忽略（保持为 null，将使用原生 ANSI 代码）
    }
  }
  return chalk;
}

// 日志文件流（仅在生产环境）
let logFile: fs.WriteStream | null = null;

export type LogLevel = 'log' | 'error' | 'warn';

/**
 * 初始化日志文件（仅在生产环境）
 */
export function initLogFile(): void {
  if (!isDev()) {
    try {
      const logDir = app.getPath('logs');
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      const logFilePath = path.join(logDir, 'tachybase.log');
      logFile = fs.createWriteStream(logFilePath, { flags: 'a' });

      // 写入启动标记
      const timestamp = new Date().toISOString();
      logFile.write(`\n\n========== Application Started: ${timestamp} ==========\n`);

      // 输出日志文件路径到控制台（方便调试）
      console.log(`[Electron] Log file: ${logFilePath}`);
    } catch (error: any) {
      console.error(`[Electron] Failed to initialize log file: ${error.message}`);
    }
  }
}

/**
 * 使用原生 ANSI 代码添加颜色
 */
function addAnsiColor(message: string, color: keyof typeof ANSI_COLORS): string {
  return `${ANSI_COLORS[color]}${message}${ANSI_COLORS.reset}`;
}

/**
 * 添加颜色到消息（在开发环境或输出到控制台时使用）
 */
function addColor(message: string, level: LogLevel): string {
  // 检查是否应该使用颜色
  const isTTY = process.stdout.isTTY && process.stderr.isTTY;
  const noColor = process.env.NO_COLOR !== undefined || process.env.FORCE_COLOR === '0';
  // 开发环境或生产环境的 TTY 输出都可以使用颜色（除非明确禁用）
  const shouldUseColor = !noColor && (isDev() || isTTY);

  if (!shouldUseColor) {
    return message;
  }

  // 尝试获取 chalk（延迟加载）
  const chalkInstance = getChalk();
  const useChalk = chalkInstance !== null;

  // 根据日志级别添加颜色
  switch (level) {
    case 'error':
      // 错误日志：红色，带错误标识
      const errorMsg = `✗ ${message}`;
      return useChalk ? chalkInstance!.red(errorMsg) : addAnsiColor(errorMsg, 'red');

    case 'warn':
      // 警告日志：黄色，带警告标识
      const warnMsg = `⚠ ${message}`;
      return useChalk ? chalkInstance!.yellow(warnMsg) : addAnsiColor(warnMsg, 'yellow');

    default:
      // 普通日志：使用蓝色或默认颜色
      // 如果消息包含 [Electron] 前缀，给前缀添加颜色
      if (message.startsWith('[Electron]')) {
        const parts = message.split('] ', 2);
        if (parts.length === 2) {
          const prefix = parts[0] + ']';
          const content = parts[1];
          if (useChalk) {
            return `${chalkInstance!.blue(prefix)} ${chalkInstance!.gray(content)}`;
          } else {
            return `${addAnsiColor(prefix, 'blue')} ${addAnsiColor(content, 'gray')}`;
          }
        } else {
          return useChalk ? chalkInstance!.blue(message) : addAnsiColor(message, 'blue');
        }
      } else {
        return useChalk ? chalkInstance!.gray(message) : addAnsiColor(message, 'gray');
      }
  }
}

/**
 * 日志输出函数（同时输出到控制台和文件）
 */
export function log(message: string, level: LogLevel = 'log'): void {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;

  // 为控制台输出添加颜色（开发环境或生产环境的 TTY 输出）
  const coloredMessage = addColor(message, level);

  // 输出到控制台（带颜色，如果支持的话）
  if (level === 'error') {
    console.error(coloredMessage);
  } else if (level === 'warn') {
    console.warn(coloredMessage);
  } else {
    console.log(coloredMessage);
  }

  // 输出到文件（仅在生产环境，文件不包含颜色代码）
  if (logFile && !isDev()) {
    logFile.write(logMessage);
  }
}

/**
 * 关闭日志文件
 */
export function closeLogFile(): void {
  if (logFile) {
    logFile.end();
    logFile = null;
  }
}

/**
 * 设置全局错误处理
 */
export function setupErrorHandlers(): void {
  process.on('uncaughtException', (error) => {
    log(`[Electron] Uncaught Exception: ${error.message}\n${error.stack}`, 'error');
  });

  process.on('unhandledRejection', (reason, promise) => {
    log(`[Electron] Unhandled Rejection at: ${promise}, reason: ${reason}`, 'error');
  });
}

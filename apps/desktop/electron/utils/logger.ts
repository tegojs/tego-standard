import * as fs from 'node:fs';
import * as path from 'node:path';

import { app } from 'electron';

// 判断是否为开发环境
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

// 日志文件流（仅在生产环境）
let logFile: fs.WriteStream | null = null;

export type LogLevel = 'log' | 'error' | 'warn';

/**
 * 初始化日志文件（仅在生产环境）
 */
export function initLogFile(): void {
  if (!isDev) {
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
 * 日志输出函数（同时输出到控制台和文件）
 */
export function log(message: string, level: LogLevel = 'log'): void {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;

  // 输出到控制台
  if (level === 'error') {
    console.error(message);
  } else if (level === 'warn') {
    console.warn(message);
  } else {
    console.log(message);
  }

  // 输出到文件（仅在生产环境）
  if (logFile && !isDev) {
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

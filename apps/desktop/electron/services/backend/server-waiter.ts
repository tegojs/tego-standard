import { ChildProcess } from 'node:child_process';

import { log } from '../../utils/logger';
import { checkBackendServer } from './server-checker';

/**
 * 等待服务器启动
 */
export async function waitForServerStart(port: number, process: ChildProcess): Promise<void> {
  log(`[Electron] Waiting for backend server to start...`);
  let retries = 60;
  let processExited = false;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;

  const exitHandler = (code: number | null, signal: string | null) => {
    processExited = true;
    exitCode = code;
    exitSignal = signal;
    log(`[Electron] Backend server process exited with code ${code}, signal ${signal}`);
  };
  process.once('exit', exitHandler);

  const errorHandler = (error: Error) => {
    log(`[Electron] Failed to start backend server: ${error.message}`, 'error');
    processExited = true;
  };
  process.once('error', errorHandler);

  while (retries > 0) {
    if (processExited || !process || process.killed) {
      const errorMsg =
        exitCode !== null
          ? `Backend server process exited with code ${exitCode}${exitSignal ? `, signal ${exitSignal}` : ''} before startup completed`
          : 'Backend server process exited unexpectedly before startup completed';
      log(`[Electron] ⚠ ${errorMsg}`, 'error');
      throw new Error(errorMsg);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
    const isRunning = await checkBackendServer(port);
    if (isRunning) {
      log(`[Electron] ✓ Backend server started successfully on port ${port}`);
      return;
    }

    retries--;
    if (retries % 10 === 0) {
      log(`[Electron] Still waiting for backend server... (${60 - retries}s elapsed)`);
    }
  }

  if (process && !process.killed) {
    log(`[Electron] ⚠ Backend server did not respond within 60 seconds, but process is still running`, 'warn');
    log(`[Electron] The server may still be starting up. Continuing anyway...`, 'warn');
  } else {
    log(`[Electron] ⚠ Backend server did not start within 60 seconds`, 'error');
    throw new Error('Backend server failed to start within timeout period');
  }
}

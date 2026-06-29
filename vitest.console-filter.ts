type OutputStream = 'stdout' | 'stderr' | string;

const expectedNegativePathLogPatterns = [
  /SQL instruction nodes require the pm\.workflow\.sql permission/,
  /SQL collection configuration requires the pm\.database-connections\.collections permission/,
  /Only select query allowed/,
  /\[error\]\s+No permissions\b/,
  /execution \(\d+\) run instruction \[sql\] for node \(\d+\) failed:/,
  /execution \(\d+\) run instruction \[error\] for node \(\d+\) failed:/,
  /Tenant context is required/,
  /Invalid tenant access/,
  /Tenant path exceeds maximum length of 500 characters/,
  /Cannot delete tenant with children\. Remove or reassign children first\./,
  /Cannot move tenant: would create a cycle/,
  /Parent tenant "disabled-parent" is disabled/,
  /"name":"JsonWebTokenError","message":"invalid signature"/,
  /Your session has expired\. Please sign in again\./,
  /File too large/,
  /file validation failed/,
  /ENOENT: no such file or directory, unlink .*test-sqlite.*storage.*uploads/i,
];

const outputFilterInstalled = Symbol.for('tego.vitest.console-output-filter-installed');

export function shouldSuppressVitestConsoleOutput(log: unknown, _type?: OutputStream) {
  const text = typeof log === 'string' ? log : Buffer.isBuffer(log) ? log.toString('utf8') : String(log ?? '');
  return expectedNegativePathLogPatterns.some((pattern) => pattern.test(text));
}

function wrapWrite(stream: NodeJS.WriteStream, type: OutputStream) {
  const originalWrite = stream.write.bind(stream);
  stream.write = ((chunk: unknown, ...args: unknown[]) => {
    if (shouldSuppressVitestConsoleOutput(chunk, type)) {
      const callback = args.find((arg): arg is () => void => typeof arg === 'function');
      callback?.();
      return true;
    }
    return originalWrite(chunk as any, ...(args as any));
  }) as typeof stream.write;
}

export function installVitestConsoleOutputFilter() {
  const globalState = globalThis as typeof globalThis & { [outputFilterInstalled]?: boolean };
  if (globalState[outputFilterInstalled]) {
    return;
  }
  wrapWrite(process.stdout, 'stdout');
  wrapWrite(process.stderr, 'stderr');
  globalState[outputFilterInstalled] = true;
}

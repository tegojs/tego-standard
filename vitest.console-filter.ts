type OutputStream = 'stdout' | 'stderr' | string;

const knownThirdPartySourcemapWarningPattern =
  /Sourcemap for ".*node_modules.*@antv(?:[+/\\])(?:scale|coord|g2-extension-plot|layout).*" points to missing source files/;

const expectedNegativePathLogPatterns = [
  /SQL instruction nodes require the pm\.workflow\.sql permission/,
  /SQL collection configuration requires the pm\.database-connections\.collections permission/,
  /Only select query allowed/,
  /\[error\]\s+No permissions\b/,
  /execution \(\d+\) run instruction \[sql\] for node \(\d+\) failed:/,
  /execution \(\d+\) run instruction \[error\] for node \(\d+\) failed:/,
  /config of executed workflow can not be updated/,
  /Tenant context is required/,
  /Invalid tenant access/,
  /No tenant is selected\. Select a tenant and try again\. If no tenant is available, contact an administrator\./,
  /未选择可用租户。请选择租户后重试；如无可选租户，请联系管理员。/,
  /You do not have access to the selected tenant\. Select an available tenant or contact an administrator\./,
  /The selected tenant is unavailable or disabled\. Select another tenant or contact an administrator\./,
  /This record is not available in the current tenant\. It may belong to another tenant or have been removed\./,
  /Tenant path exceeds maximum length of 500 characters/,
  /The tenant hierarchy is too deep\. Select a higher-level parent tenant\./,
  /Cannot delete tenant with children\. Remove or reassign children first\./,
  /Cannot move tenant: would create a cycle/,
  /Parent tenant "disabled-parent" is disabled/,
  /This tenant has child tenants\. Move or delete them before deleting this tenant\./,
  /该租户仍有下级租户。请先移动或删除下级租户。/,
  /This tenant is set as a user's default tenant\. Reassign those users before deleting it\./,
  /This tenant still has members\. Remove all members before deleting it\./,
  /This tenant cannot be moved under itself or one of its descendants\./,
  /The selected parent tenant is disabled\. Enable it or select another parent tenant\./,
  /"name":"JsonWebTokenError","message":"invalid signature"/,
  /Your session has expired\. Please sign in again\./,
  /File too large/,
  /file validation failed/,
  /ENOENT: no such file or directory, unlink .*test-sqlite.*storage.*uploads/i,
  knownThirdPartySourcemapWarningPattern,
];

const outputFilterInstalled = Symbol.for('tego.vitest.console-output-filter-installed');

export function shouldSuppressVitestConsoleOutput(log: unknown, _type?: OutputStream) {
  const text = typeof log === 'string' ? log : Buffer.isBuffer(log) ? log.toString('utf8') : String(log ?? '');
  return expectedNegativePathLogPatterns.some((pattern) => pattern.test(text));
}

export function shouldSuppressViteWarning(log: unknown) {
  const text = typeof log === 'string' ? log : Buffer.isBuffer(log) ? log.toString('utf8') : String(log ?? '');
  return knownThirdPartySourcemapWarningPattern.test(text);
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

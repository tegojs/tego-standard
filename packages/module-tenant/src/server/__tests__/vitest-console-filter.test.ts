import { describe, expect, it } from 'vitest';

import { shouldSuppressVitestConsoleOutput } from '../../../../../vitest.console-filter';

describe('shouldSuppressVitestConsoleOutput', () => {
  it('suppresses expected server error logs emitted by negative-path tests', () => {
    expect(
      shouldSuppressVitestConsoleOutput(
        '2026-06-30 [error] SQL instruction nodes require the pm.workflow.sql permission meta={}',
        'stdout',
      ),
    ).toBe(true);
    expect(shouldSuppressVitestConsoleOutput('[error] Tenant context is required meta={}', 'stdout')).toBe(true);
    expect(shouldSuppressVitestConsoleOutput('[error] File too large meta={}', 'stdout')).toBe(true);
    expect(
      shouldSuppressVitestConsoleOutput(
        "ENOENT: no such file or directory, unlink 'C:/tmp/test-sqlite/storage/uploads/file.txt'",
        'stderr',
      ),
    ).toBe(true);
  });

  it('keeps unexpected logs visible', () => {
    expect(shouldSuppressVitestConsoleOutput('[error] database connection lost', 'stderr')).toBe(false);
    expect(shouldSuppressVitestConsoleOutput('unexpected warning', 'stdout')).toBe(false);
  });
});

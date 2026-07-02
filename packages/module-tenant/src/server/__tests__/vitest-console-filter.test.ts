import { describe, expect, it } from 'vitest';

import { shouldSuppressVitestConsoleOutput, shouldSuppressViteWarning } from '../../../../../vitest.console-filter';

describe('shouldSuppressVitestConsoleOutput', () => {
  it('suppresses expected server error logs emitted by negative-path tests', () => {
    expect(
      shouldSuppressVitestConsoleOutput(
        '2026-06-30 [error] SQL instruction nodes require the pm.workflow.sql permission meta={}',
        'stdout',
      ),
    ).toBe(true);
    expect(shouldSuppressVitestConsoleOutput('[error] Tenant context is required meta={}', 'stdout')).toBe(true);
    expect(shouldSuppressVitestConsoleOutput('[error] Invalid tenant access meta={}', 'stdout')).toBe(true);
    expect(shouldSuppressVitestConsoleOutput('[error] File too large meta={}', 'stdout')).toBe(true);
    expect(
      shouldSuppressVitestConsoleOutput(
        '2026-06-30 [error] execution (19) run instruction [error] for node (3) failed:',
        'stdout',
      ),
    ).toBe(true);
    expect(
      shouldSuppressVitestConsoleOutput(
        '2026-06-30 [error] config of executed workflow can not be updated meta={}',
        'stdout',
      ),
    ).toBe(true);
    expect(
      shouldSuppressVitestConsoleOutput(
        '2026-06-30 [error] SQL collection configuration requires the pm.database-connections.collections permission',
        'stdout',
      ),
    ).toBe(true);
    expect(shouldSuppressVitestConsoleOutput('2026-06-30 [error] Only select query allowed', 'stdout')).toBe(true);
    expect(
      shouldSuppressVitestConsoleOutput('Error: Tenant path exceeds maximum length of 500 characters', 'stderr'),
    ).toBe(true);
    expect(
      shouldSuppressVitestConsoleOutput(
        'Error: Cannot delete tenant with children. Remove or reassign children first.',
        'stderr',
      ),
    ).toBe(true);
    expect(shouldSuppressVitestConsoleOutput('Error: Cannot move tenant: would create a cycle', 'stderr')).toBe(true);
    expect(shouldSuppressVitestConsoleOutput('Error: Parent tenant "disabled-parent" is disabled', 'stderr')).toBe(
      true,
    );
    expect(
      shouldSuppressVitestConsoleOutput(
        "ENOENT: no such file or directory, unlink 'C:/tmp/test-sqlite/storage/uploads/file.txt'",
        'stderr',
      ),
    ).toBe(true);
  });

  it('suppresses known third-party sourcemap warnings from Vite', () => {
    expect(
      shouldSuppressVitestConsoleOutput(
        'Sourcemap for "/home/runner/work/tego-standard/tego-standard/node_modules/.pnpm/@antv+scale@0.4.16/node_modules/@antv/scale/esm/index.js" points to missing source files',
        'stderr',
      ),
    ).toBe(true);
    expect(
      shouldSuppressVitestConsoleOutput(
        'Sourcemap for "D:/Dev/TegoJS/tego-standard/node_modules/.pnpm/@antv+g2-extension-plot@0.2.2/node_modules/@antv/g2-extension-plot/esm/index.js" points to missing source files',
        'stderr',
      ),
    ).toBe(true);
  });

  it('matches known third-party sourcemap warnings at Vite logger level', () => {
    expect(
      shouldSuppressViteWarning(
        'Sourcemap for "/home/runner/work/tego-standard/tego-standard/node_modules/.pnpm/@antv+coord@0.4.7/node_modules/@antv/coord/esm/index.js" points to missing source files',
      ),
    ).toBe(true);
    expect(
      shouldSuppressViteWarning(
        'Sourcemap for "/home/runner/work/tego-standard/tego-standard/node_modules/@antv/scale/esm/index.js" points to missing source files',
      ),
    ).toBe(true);
    expect(
      shouldSuppressViteWarning(
        'Sourcemap for "/home/runner/work/tego-standard/tego-standard/packages/client/src/index.ts" points to missing source files',
      ),
    ).toBe(false);
  });

  it('keeps unexpected logs visible', () => {
    expect(shouldSuppressVitestConsoleOutput('[error] database connection lost', 'stderr')).toBe(false);
    expect(shouldSuppressVitestConsoleOutput('unexpected warning', 'stdout')).toBe(false);
    expect(
      shouldSuppressVitestConsoleOutput(
        'Sourcemap for "/home/runner/work/tego-standard/tego-standard/packages/client/src/index.ts" points to missing source files',
        'stderr',
      ),
    ).toBe(false);
  });
});

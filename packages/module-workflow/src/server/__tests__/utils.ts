import { getApp, sleep } from '@tachybase/plugin-workflow-test';

export const FAST_POLL_INTERVAL_MS = 50;

export async function waitForAssertion(assertion: () => Promise<void> | void, timeout = 10000, interval = 200) {
  const start = Date.now();
  let lastError: unknown;

  while (Date.now() - start < timeout) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await sleep(interval);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('waitForAssertion timed out');
}

export async function waitForFastAssertion(assertion: () => Promise<void> | void, timeout?: number) {
  return waitForAssertion(assertion, timeout, FAST_POLL_INTERVAL_MS);
}

export async function waitForWorkflowJob(
  workflow,
  assertion: (execution, jobs) => Promise<void> | void,
  options: { executionOptions?: any; jobOptions?: any; timeout?: number; interval?: number } = {},
) {
  const { executionOptions, jobOptions, timeout, interval } = options;

  await waitForAssertion(
    async () => {
      const [execution] = await workflow.getExecutions(executionOptions);
      expect(execution).toBeTruthy();

      const jobs = await execution.getJobs(jobOptions);
      expect(jobs.length).toBeGreaterThan(0);

      await assertion(execution, jobs);
    },
    timeout,
    interval,
  );
}

export async function waitForWorkflowJobFast(
  workflow,
  assertion: (execution, jobs) => Promise<void> | void,
  options: { executionOptions?: any; jobOptions?: any; timeout?: number; interval?: number } = {},
) {
  return waitForWorkflowJob(workflow, assertion, {
    interval: FAST_POLL_INTERVAL_MS,
    ...options,
  });
}

export async function waitForWorkflowIdle(app, options: { timeout?: number; interval?: number } = {}) {
  const { timeout, interval } = options;
  const plugin = app.pm.get('workflow') as any;

  await waitForAssertion(
    () => {
      expect(plugin.events?.length ?? 0).toBe(0);
      expect(plugin.pending?.length ?? 0).toBe(0);
      expect(plugin.executing).toBeFalsy();
    },
    timeout,
    interval,
  );
}

export function createWorkflowTestAppCache<TApp = any>(bindApp: (app: TApp) => void) {
  let cachedApp: TApp;
  let cachedAppKey: string;

  return {
    async useApp(options: { plugins?: string[]; withAnotherDataSource?: boolean } = {}) {
      const appKey = JSON.stringify(options);

      if (cachedAppKey !== appKey) {
        if (cachedApp) {
          await (cachedApp as any).destroy();
        }

        cachedApp = (await getApp(options)) as TApp;
        cachedAppKey = appKey;
      }

      bindApp(cachedApp);
      return cachedApp;
    },

    async destroy() {
      await (cachedApp as any)?.destroy();
    },
  };
}

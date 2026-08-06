const FAST_POLL_INTERVAL_MS = 50;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForFastAssertion(assertion: () => Promise<void> | void, timeout = 10000) {
  const start = Date.now();
  let lastError: unknown;

  while (Date.now() - start < timeout) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await sleep(FAST_POLL_INTERVAL_MS);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('waitForFastAssertion timed out');
}

export async function waitForWorkflowIdle(
  app,
  options: {
    timeout?: number;
    interval?: number;
  } = {},
) {
  const { timeout = 10000, interval = FAST_POLL_INTERVAL_MS } = options;
  const start = Date.now();
  let lastError: unknown;

  while (Date.now() - start < timeout) {
    try {
      const plugin = app.pm.get('workflow') as any;
      if ((plugin.events?.length ?? 0) > 0 || (plugin.pending?.length ?? 0) > 0 || plugin.executing) {
        throw new Error('Workflow is still running');
      }
      return;
    } catch (error) {
      lastError = error;
      await sleep(interval);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('waitForWorkflowIdle timed out');
}

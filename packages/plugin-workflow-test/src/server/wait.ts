const FAST_POLL_INTERVAL_MS = 50;
const FINAL_ASSERTION_GRACE_MS = 100;
const WAIT_FOR_FAST_ASSERTION_TIMEOUT = 'waitForFastAssertion timed out';

class AssertionTimeoutError extends Error {}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runAssertionWithinTimeout(assertion: () => Promise<void> | void, timeout: number) {
  let timeoutHandle: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new AssertionTimeoutError()), Math.max(0, timeout));
  });

  try {
    await Promise.race([Promise.resolve().then(assertion), timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function isWorkflowIdle(plugin: any) {
  const hasEvents = (plugin.events?.length ?? 0) > 0;
  const hasPendingItems = (plugin.pending?.length ?? 0) > 0;
  return !hasEvents && !hasPendingItems && !plugin.executing;
}

export async function waitForFastAssertion(assertion: () => Promise<void> | void, timeout = 10000) {
  const start = Date.now();
  let lastError: unknown;

  while (Date.now() - start < timeout) {
    try {
      await runAssertionWithinTimeout(assertion, timeout - (Date.now() - start));
      return;
    } catch (error) {
      if (!(error instanceof AssertionTimeoutError)) {
        lastError = error;
      }
      await sleep(FAST_POLL_INTERVAL_MS);
    }
  }

  try {
    await runAssertionWithinTimeout(assertion, FINAL_ASSERTION_GRACE_MS);
    return;
  } catch (error) {
    if (!(error instanceof AssertionTimeoutError)) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(WAIT_FOR_FAST_ASSERTION_TIMEOUT);
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
  const plugin = app.pm.get('workflow') as any;
  if (!plugin) {
    throw new Error('Workflow plugin is not available');
  }

  while (Date.now() - start < timeout) {
    if (isWorkflowIdle(plugin)) {
      return;
    }
    await sleep(interval);
  }

  if (isWorkflowIdle(plugin)) {
    return;
  }
  throw new Error('waitForWorkflowIdle timed out');
}

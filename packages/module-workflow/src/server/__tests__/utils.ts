import { sleep } from '@tachybase/plugin-workflow-test';

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

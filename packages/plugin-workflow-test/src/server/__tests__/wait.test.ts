import { describe, expect, it, vi } from 'vitest';

import { waitForFastAssertion, waitForWorkflowIdle } from '../wait';

describe('waitForFastAssertion', () => {
  it('retries a failed assertion until it succeeds', async () => {
    const assertion = vi.fn();
    assertion.mockRejectedValueOnce(new Error('not ready'));
    assertion.mockResolvedValue(undefined);

    await expect(waitForFastAssertion(assertion, 200)).resolves.toBeUndefined();
    expect(assertion).toHaveBeenCalledTimes(2);
  });

  it('throws the last assertion error after timing out', async () => {
    const lastError = new Error('still not ready');
    const assertion = vi.fn(() => {
      throw lastError;
    });

    await expect(waitForFastAssertion(assertion, 1)).rejects.toBe(lastError);
    expect(assertion).toHaveBeenCalledTimes(2);
  });

  it('times out when an assertion promise never settles', async () => {
    const assertion = vi.fn(() => new Promise<void>(() => {}));
    let guardTimeout: ReturnType<typeof setTimeout>;
    const guard = new Promise<never>((_, reject) => {
      guardTimeout = setTimeout(() => reject(new Error('test guard timed out')), 200);
    });

    try {
      await expect(Promise.race([waitForFastAssertion(assertion, 10), guard])).rejects.toThrow(
        'waitForFastAssertion timed out',
      );
    } finally {
      clearTimeout(guardTimeout);
    }
  });
});

describe('waitForWorkflowIdle', () => {
  it('returns when the workflow plugin is idle', async () => {
    const plugin = { events: [], pending: [], executing: false };
    const app = { pm: { get: vi.fn(() => plugin) } };

    await expect(waitForWorkflowIdle(app)).resolves.toBeUndefined();
  });

  it('checks the idle state once more at the timeout boundary', async () => {
    vi.useFakeTimers();
    const plugin = { events: [], pending: [{}], executing: false };
    const app = { pm: { get: vi.fn(() => plugin) } };

    try {
      const result = waitForWorkflowIdle(app, { timeout: 10, interval: 10 }).then(
        () => 'resolved',
        (error) => error,
      );
      plugin.pending = [];
      await vi.advanceTimersByTimeAsync(10);
      await expect(result).resolves.toBe('resolved');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails immediately with a clear error when the workflow plugin is missing', async () => {
    const getPlugin = vi.fn(() => undefined);
    const app = { pm: { get: getPlugin } };

    await expect(waitForWorkflowIdle(app, { timeout: 5, interval: 1 })).rejects.toThrow(
      'Workflow plugin is not available',
    );
    expect(getPlugin).toHaveBeenCalledOnce();
  });
});

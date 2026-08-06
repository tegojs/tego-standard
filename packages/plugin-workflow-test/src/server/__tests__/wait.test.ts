import { describe, expect, it, vi } from 'vitest';

import { waitForWorkflowIdle } from '../wait';

describe('waitForWorkflowIdle', () => {
  it('fails immediately with a clear error when the workflow plugin is missing', async () => {
    const getPlugin = vi.fn(() => undefined);
    const app = { pm: { get: getPlugin } };

    await expect(waitForWorkflowIdle(app, { timeout: 5, interval: 1 })).rejects.toThrow(
      'Workflow plugin is not available',
    );
    expect(getPlugin).toHaveBeenCalledOnce();
  });
});

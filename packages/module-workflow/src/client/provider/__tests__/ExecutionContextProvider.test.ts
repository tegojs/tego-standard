import { describe, expect, it } from 'vitest';

import { hasExecutionContext } from '../execution-context';

describe('workflow execution context', () => {
  it.each([
    [undefined, { id: 1 }, []],
    [{ type: 'approval' }, undefined, []],
    [{ type: 'approval' }, { id: 1 }, undefined],
    [{ type: 'approval' }, { id: 1 }, null],
  ])('rejects incomplete context', (workflow, execution, nodes) => {
    expect(hasExecutionContext(workflow, execution, nodes)).toBe(false);
  });

  it('accepts a workflow context with an empty node list', () => {
    expect(hasExecutionContext({ type: 'approval' }, { id: 1 }, [])).toBe(true);
  });
});

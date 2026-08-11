import { describe, expect, it } from 'vitest';

import { JOB_STATUS } from '../../../constants';
import { ScriptInstruction } from '../script.instruction';

describe('ScriptInstruction', () => {
  it('runs a legacy node without a sourceArray', async () => {
    const instruction = new ScriptInstruction({} as any);
    const result = await instruction.run(
      {
        id: 1,
        config: {
          type: 'js',
          code: 'ctx.body = { ok: true };',
        },
      } as any,
      undefined,
      {} as any,
    );

    expect(result).toEqual({
      result: { ok: true },
      status: JOB_STATUS.RESOLVED,
    });
  });
});

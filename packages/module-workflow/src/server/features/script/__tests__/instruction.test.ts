import { describe, expect, it, vi } from 'vitest';

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

  it('uses empty arrays for nullish data sources while preserving values', async () => {
    const instruction = new ScriptInstruction({} as any);
    const processor = {
      getParsedValue: vi.fn((sourcePath: string) => (sourcePath === 'empty' ? null : [{ id: 1 }])),
    } as any;
    const result = await instruction.run(
      {
        id: 1,
        config: {
          sourceArray: [
            { keyName: 'emptyItems', sourcePath: 'empty' },
            { keyName: 'items', sourcePath: 'items' },
          ],
          type: 'js',
          code: `const { emptyItems, items } = ctx.data;
ctx.body = [emptyItems, items].filter((item) => item.length > 0);`,
        },
      } as any,
      undefined,
      processor,
    );

    expect(result).toEqual({
      result: [[{ id: 1 }]],
      status: JOB_STATUS.RESOLVED,
    });
    expect(processor.getParsedValue).toHaveBeenNthCalledWith(1, 'empty', 1);
    expect(processor.getParsedValue).toHaveBeenNthCalledWith(2, 'items', 1);
  });
});

import { evalSimulate } from '../utils/eval-simulate';

describe('evalSimulate', () => {
  it.each(['\n', '\r\n'])('executes scripts ending in a line comment with %j line endings', async (newline) => {
    const ctx = { action: { params: { id: 42 } }, body: undefined };
    const code = ['ctx.body = await Promise.resolve(ctx.action.params.id)', '// trailing comment'].join(newline);

    await evalSimulate(code, { ctx, lib: {} });

    expect(ctx.body).toBe(42);
  });

  it('accepts a script containing only a line comment', async () => {
    await expect(evalSimulate('// no processing needed', { ctx: {}, lib: {} })).resolves.toBeUndefined();
  });

  it('preserves return values and context bindings', async () => {
    const ctx = { id: 42 };

    await expect(evalSimulate('return lib.JSON.stringify(__ctx);', { ctx, lib: { JSON } })).resolves.toBe('{"id":42}');
  });

  it('propagates script errors unchanged', async () => {
    const error = new Error('script failed');

    await expect(evalSimulate('throw ctx.error;', { ctx: { error }, lib: {} })).rejects.toBe(error);
  });

  it('still rejects invalid syntax', async () => {
    await expect(evalSimulate('ctx.body = );', { ctx: {}, lib: {} })).rejects.toBeInstanceOf(SyntaxError);
  });
});

import { describe, expect, it } from 'vitest';

import { serializeError } from '../tools';

describe('serializeError', () => {
  it('uses a stable message when an object cannot be converted to a string', () => {
    const error = Object.assign(Object.create(null), { message: 42 });

    expect(serializeError(error)).toEqual({
      name: undefined,
      message: 'Unknown error',
      stack: undefined,
    });
  });

  it('safely serializes a proxy whose properties throw', () => {
    const error = new Proxy(
      {},
      {
        get() {
          throw new Error('property access failed');
        },
      },
    );

    expect(serializeError(error)).toEqual({
      name: undefined,
      message: 'Unknown error',
      stack: undefined,
    });
  });
});

import { describe, expect, it } from 'vitest';

import render from '../renders';

describe('export render', () => {
  it('should render an empty workbook payload when no fields are selected', async () => {
    await expect(render({ columns: [], fields: [], data: [], utcOffset: undefined }, {} as any)).resolves.toEqual({
      rows: [],
      ranges: [],
    });
  });
});

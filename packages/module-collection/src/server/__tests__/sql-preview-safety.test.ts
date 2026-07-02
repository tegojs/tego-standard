import { describe, expect, it } from 'vitest';

import { isReadOnlyPreviewSql } from '../resourcers/sql';

describe('sqlCollection preview SQL safety', () => {
  it('does not let string literal comment markers hide writable CTE keywords', () => {
    const sql = `
      WITH marker AS (
        SELECT '/*' AS text
      ),
      updated AS (
        UPDATE accounts SET name = 'x' RETURNING *
      ),
      tail AS (
        SELECT '*/' AS text
      )
      SELECT * FROM updated
    `;

    expect(isReadOnlyPreviewSql(sql)).toBe(false);
  });

  it('allows read-only SQL with comment markers and writable words inside literals', () => {
    const sql = `
      SELECT
        '/* update accounts set name = ''x'' */' AS text,
        '-- drop table accounts' AS line_text,
        "delete" AS quoted_identifier
    `;

    expect(isReadOnlyPreviewSql(sql)).toBe(true);
  });
});

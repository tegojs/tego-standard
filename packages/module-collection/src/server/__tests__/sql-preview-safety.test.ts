import { describe, expect, it, vi } from 'vitest';

import { isReadOnlyPreviewSql, runReadOnlyPreviewQuery } from '../resourcers/sql';

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

  it('allows replace as a read-only function call', () => {
    const sql = `
      SELECT replace(name, 'old', 'new') AS normalized_name
      FROM accounts
    `;

    expect(isReadOnlyPreviewSql(sql)).toBe(true);
  });

  it('rejects additional statements after a read-only query', () => {
    expect(isReadOnlyPreviewSql('SELECT 1; DELETE FROM accounts')).toBe(false);
  });

  it('rejects select into because it creates data', () => {
    expect(isReadOnlyPreviewSql('SELECT * INTO copied_accounts FROM accounts')).toBe(false);
  });

  it('runs preview query in a database read-only transaction', async () => {
    const transaction = { id: 'preview-readonly-tx' };
    const calls: string[] = [];
    const query = vi.fn(async () => {
      calls.push('set-readonly');
    });
    const transactionFn = vi.fn(async (options, callback) => {
      calls.push('transaction');
      expect(options).toMatchObject({ readOnly: true });
      return callback(transaction);
    });
    const findAll = vi.fn(async (options) => {
      calls.push('find');
      expect(options).toMatchObject({
        attributes: ['*'],
        limit: 5,
        raw: true,
        transaction,
      });
      return [{ id: 1 }];
    });

    const result = await runReadOnlyPreviewQuery(
      {
        db: {
          options: { dialect: 'postgres' },
          sequelize: {
            getDialect: () => 'postgres',
            query,
            transaction: transactionFn,
          },
        },
      } as any,
      { findAll } as any,
    );

    expect(result).toEqual([{ id: 1 }]);
    expect(query).toHaveBeenCalledWith('SET TRANSACTION READ ONLY', { transaction });
    expect(calls).toEqual(['transaction', 'set-readonly', 'find']);
  });
});

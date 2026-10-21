import { describe, expect, it } from 'vitest';

import { captureExportXlsxRequest } from '../actions/export-request';

describe('scoped export request capture', () => {
  it('partitions POST presentation options and selects all displayed paths for authorization', () => {
    const request = captureExportXlsxRequest({
      resourceName: 'documents',
      actionName: 'export',
      filterByTk: undefined,
      title: 'Query title',
      columns: ['id'],
      appends: 'participants,owner',
      values: { title: 'Body title', columns: [{ dataIndex: ['participants', 'name'], title: '参与方' }] },
      fields: ['id'],
      sort: '-id',
      filter: { amount: { $gte: 10 } },
    });
    expect(request).toEqual({
      title: 'Query title',
      columns: [{ dataIndex: ['participants', 'name'], title: '参与方' }],
      params: {
        resourceName: 'documents',
        actionName: 'export',
        filterByTk: undefined,
        appends: ['participants', 'owner'],
        fields: ['id', 'participants.name'],
        sort: '-id',
        filter: { amount: { $gte: 10 } },
      },
    });
  });

  it('accepts GET JSON columns, title fallback and empty page appends', () => {
    expect(
      captureExportXlsxRequest({
        columns: '["id"]',
        appends: '',
        values: { title: 'Body title' },
      }),
    ).toEqual({ columns: [{ dataIndex: ['id'] }], title: 'Body title', params: { fields: ['id'], appends: [] } });
  });

  it('copies filter, path and enum data before asynchronous authorization', () => {
    const input = {
      filter: { id: { $in: [1, 3] } },
      values: { columns: [{ dataIndex: ['name'], enum: [{ value: 'one', label: '一' }] }] },
    };
    const request = captureExportXlsxRequest(input);
    input.filter.id.$in.push(4);
    input.values.columns[0].dataIndex[0] = 'secret';
    input.values.columns[0].enum[0].label = 'changed';
    expect(request.params.filter).toEqual({ id: { $in: [1, 3] } });
    expect(request.columns).toEqual([{ dataIndex: ['name'], enum: [{ value: 'one', label: '一' }] }]);
  });

  it('keeps unsupported query controls for the strict read adapter to reject', () => {
    const request = captureExportXlsxRequest({ columns: ['id'], limit: 1, permission: { skip: true } });
    expect(request.params).toEqual({ fields: ['id'], limit: 1, permission: { skip: true } });
  });

  it.each([
    null,
    [],
    { title: {} },
    { values: [] },
    { values: { tenantId: 'C' } },
    { values: { columns: ['id'], filter: {} } },
    { columns: '{' },
    { columns: {} },
    { columns: [{ dataIndex: [] }] },
    { columns: [{ dataIndex: ['participants', 'a', 'b', 'c', 'id'] }] },
    { columns: [{ dataIndex: ['constructor', 'name'] }] },
    { columns: [{ dataIndex: ['__proto__', 'name'] }] },
    { columns: [{ dataIndex: ['name'], sql: 'SELECT 1' }] },
    { columns: [{ dataIndex: ['name'], enum: [{ value: {}, label: 'x' }] }] },
    { columns: [{ dataIndex: ['name'], title: {} }] },
    { appends: [''] },
    { fields: ['id', 1] },
    { columns: Array.from({ length: 1001 }, () => 'id') },
    { title: 'a'.repeat(1025) },
    { filter: { at: new Date() } },
  ])('rejects invalid or oversized file input: %j', (input) => {
    expect(() => captureExportXlsxRequest(input)).toThrowError(expect.objectContaining({ status: 400 }));
  });

  it('rejects accessor payloads without evaluating them', () => {
    let evaluated = false;
    const input = {
      columns: [
        {
          dataIndex: ['id'],
          get title() {
            evaluated = true;
            return 'Secret';
          },
        },
      ],
    };
    expect(() => captureExportXlsxRequest(input)).toThrow();
    expect(evaluated).toBe(false);
  });

  it('rejects sparse columns instead of omitting entries', () => {
    const columns: string[] = [];
    columns.length = 1;
    expect(() => captureExportXlsxRequest({ columns })).toThrowError(expect.objectContaining({ status: 400 }));
  });

  it('rejects a sparse query array even when an extra property masks its missing index', () => {
    const ids: number[] = [];
    ids.length = 1;
    Object.defineProperty(ids, 'extra', { value: 1, enumerable: true });
    expect(() => captureExportXlsxRequest({ columns: ['id'], filter: { id: { $in: ids } } })).toThrowError(
      expect.objectContaining({ status: 400 }),
    );
  });
});

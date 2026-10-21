import { mockDatabase, type Context } from '@tego/server';

import xlsx from 'node-xlsx';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderExportXlsxRows, type ExportXlsxRowsInput } from '../actions/render-xlsx';

describe('rendering already authorized export projections', () => {
  let db: ReturnType<typeof mockDatabase>;

  beforeEach(() => {
    db = mockDatabase({ dialect: 'sqlite', storage: ':memory:', logging: false });
    db.collection({
      name: 'documents',
      timestamps: false,
      fields: [
        { name: 'name', type: 'string' },
        { name: 'payload', type: 'json' },
        { name: 'enabled', type: 'boolean', interface: 'boolean' },
        { name: 'status', type: 'string', interface: 'select' },
      ],
    });
    db.collection({
      name: 'projects',
      timestamps: false,
      fields: [
        { name: 'name', type: 'string' },
        { name: 'secret', type: 'string', defaultValue: 'must not be reconstructed' },
      ],
    });
    db.collection({ name: 'customers', timestamps: false, fields: [{ name: 'name', type: 'string' }] });
    db.getCollection('documents').setField('project', { type: 'belongsTo', target: 'projects' });
    db.getCollection('projects').setField('customer', { type: 'belongsTo', target: 'customers' });
    db.getCollection('documents').setField('viewers', { type: 'hasMany', target: 'customers' });
    db.getCollection('documents').setField('labels', { type: 'belongsToMany', target: 'customers' });
    // Deliberately never sync: a renderer that reloads records will fail against missing business tables.
  });

  afterEach(async () => {
    await db.close();
  });

  async function render(data: ExportXlsxRowsInput['data'], paths: string[][]) {
    const headers: Record<string, string> = {};
    const ctx = {
      db,
      get: () => '+08:00',
      set: (values: Record<string, string>) => Object.assign(headers, values),
      body: undefined,
    } as unknown as Context;
    await renderExportXlsxRows(ctx, {
      collection: db.getCollection('documents'),
      columns: paths.map((dataIndex) => ({ dataIndex })),
      data,
      title: 'Authorized',
      tenantId: 'B',
    });
    return { rows: xlsx.parse(ctx.body as Buffer)[0].data, headers };
  }

  it('renders nested single relations with omitted keys, shared path prefixes and scalar JSON values', async () => {
    const rows = [
      {
        name: 'D1',
        project: { name: 'Visible project', customer: { name: 'Visible customer' } },
        payload: { label: 'JSON value' },
      },
    ];
    const snapshot = structuredClone(rows);
    const result = await render(rows, [
      ['name'],
      ['project', 'name'],
      ['project', 'customer', 'name'],
      ['payload', 'label'],
    ]);
    expect(result.rows).toEqual([
      ['name', 'name', 'name', 'label'],
      ['D1', 'Visible project', 'Visible customer', 'JSON value'],
    ]);
    expect(rows).toEqual(snapshot);
    expect(result.headers['Content-Disposition']).toContain('Authorized_B.xlsx');
    expect(result.headers['Content-Type']).toBe('application/octet-stream');
  });

  it('keeps only supplied multi-relations including many-to-many rows without primary keys', async () => {
    const result = await render(
      [{ name: 'D1', viewers: [{ name: 'A' }, { name: 'B' }], labels: [{ name: 'C' }, { name: 'D' }] }],
      [['name'], ['viewers', 'name'], ['labels', 'name']],
    );
    expect(result.rows).toEqual([
      ['name', 'name', 'name'],
      ['D1', 'A,B', 'C,D'],
    ]);
  });

  it('preserves null and empty relations without inventing defaults or reloading omitted values', async () => {
    const result = await render(
      [
        { project: null, viewers: [], labels: [], name: 'Hidden' },
        { project: {}, name: 'Omitted' },
      ],
      [['project', 'secret'], ['viewers', 'name'], ['labels', 'name'], ['name']],
    );
    expect(result.rows).toEqual([
      ['secret', 'name', 'name', 'name'],
      [undefined, '', '', 'Hidden'],
      [undefined, undefined, undefined, 'Omitted'],
    ]);
  });

  it('retains existing boolean and explicit selection labels on projected scalar values', async () => {
    const headers: Record<string, string> = {};
    const ctx = {
      db,
      get: () => '+08:00',
      set: (values: Record<string, string>) => Object.assign(headers, values),
      body: undefined,
    } as unknown as Context;
    await renderExportXlsxRows(ctx, {
      collection: db.getCollection('documents'),
      columns: [
        { dataIndex: ['enabled'], enum: [{ value: false, label: 'Disabled' }] },
        { dataIndex: ['status'], enum: [{ value: 'ok', label: 'Approved' }] },
      ],
      data: [{ enabled: false, status: 'ok' }],
    });
    expect(xlsx.parse(ctx.body as Buffer)[0].data).toEqual([
      ['enabled', 'status'],
      ['Disabled', 'Approved'],
    ]);
  });

  it('renders an empty authorized result as headers only', async () => {
    const result = await render([], [['name'], ['project', 'customer', 'name']]);
    expect(result.rows).toEqual([['name', 'name']]);
  });
});

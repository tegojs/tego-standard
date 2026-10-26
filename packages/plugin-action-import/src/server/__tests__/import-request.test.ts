import xlsx from 'node-xlsx';
import * as XLSX from 'xlsx';

import { captureImportXlsxRequest } from '..';

const columns = () => [
  { dataIndex: ['title'], title: 'Custom title', defaultTitle: 'Title' },
  { dataIndex: ['project', 'name'], defaultTitle: 'Project/Name', enum: [{ value: 42, label: 'Project A' }] },
];
const workbook = (data: unknown[][]) => xlsx.build([{ name: 'Import', data }]);
const input = () => ({
  buffer: workbook([
    ['Title', 'Project/Name'],
    ['Document', 'Project A'],
  ]),
  columns: columns(),
});

describe('independent import spreadsheet capture', () => {
  it.each(['json', 'array'])(
    'captures actual page %s columns and preserves every path for later authorization',
    (kind) => {
      const request = input();
      const result = captureImportXlsxRequest({
        ...request,
        columns: kind === 'json' ? JSON.stringify(request.columns) : request.columns,
      });
      expect(result).toEqual({
        columns: [
          { dataIndex: ['title'], title: 'Custom title', defaultTitle: 'Title' },
          { dataIndex: ['project', 'name'], defaultTitle: 'Project/Name', enum: [{ value: 42, label: 'Project A' }] },
        ],
        fields: ['title', 'project.name'],
        header: ['Title', 'Project/Name'],
        rows: [{ rowNumber: 2, cells: ['Document', 'Project A'] }],
      });
    },
  );

  it('accepts the existing generated template with an explanation before its header', () => {
    const result = captureImportXlsxRequest({
      columns: columns(),
      buffer: workbook([['Fill the following columns'], ['Title', 'Project/Name'], ['Document', 'Project A']]),
    });
    expect(result.header).toEqual(['Title', 'Project/Name']);
    expect(result.rows).toEqual([{ rowNumber: 3, cells: ['Document', 'Project A'] }]);
  });

  it('keeps physical row numbers, null cells, whitespace and zero rather than shifting values', () => {
    const result = captureImportXlsxRequest({
      columns: columns(),
      buffer: workbook([[], ['Title', 'Project/Name'], [null, 'Project A'], [], ['  Document  ', 0], [' ', null]]),
    });
    expect(result.rows).toEqual([
      { rowNumber: 3, cells: [null, 'Project A'] },
      { rowNumber: 5, cells: ['  Document  ', '0'] },
    ]);
  });

  it('retains number/date display formatting and reads cached formulas without evaluating them', () => {
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([['Amount', 'Date', 'Formula']]);
    sheet.A2 = { t: 'n', v: 1234.5, z: '#,##0.00' };
    sheet.B2 = { t: 'n', v: 45292, z: 'yyyy-mm-dd' };
    sheet.C2 = { t: 'n', v: 2, f: '1+1' };
    sheet['!ref'] = 'A1:C2';
    XLSX.utils.book_append_sheet(book, sheet, 'Import');
    const result = captureImportXlsxRequest({
      columns: ['Amount', 'Date', 'Formula'].map((name) => ({ dataIndex: [name], defaultTitle: name })),
      buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }),
    });
    expect(result.rows).toEqual([{ rowNumber: 2, cells: ['1,234.50', '2024-01-01', '2'] }]);
  });

  it.each(['mapped value', 'only row value', 'unmapped column'])(
    'rejects Excel errors in %s instead of converting them to missing data',
    (location) => {
      const book = XLSX.utils.book_new();
      const sheet = XLSX.utils.aoa_to_sheet([['Title', 'Project/Name']]);
      if (location !== 'only row value') sheet.A2 = { t: 's', v: 'Document' };
      const address = location === 'unmapped column' ? 'C2' : 'B2';
      sheet[address] = { t: 'e', v: 7, f: '1/0' };
      sheet['!ref'] = location === 'unmapped column' ? 'A1:C2' : 'A1:B2';
      XLSX.utils.book_append_sheet(book, sheet, 'Import');
      expect(() =>
        captureImportXlsxRequest({
          columns: columns(),
          buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }),
        }),
      ).toThrow(expect.objectContaining({ code: 'INVALID_IMPORT_REQUEST', status: 400 }));
    },
  );

  it('uses only the first sheet as the existing importer does', () => {
    const result = captureImportXlsxRequest({
      columns: columns(),
      buffer: xlsx.build([
        {
          name: 'Import',
          data: [
            ['Title', 'Project/Name'],
            ['First sheet', null],
          ],
        },
        { name: 'Other', data: [['Wrong'], ['Do not import']] },
      ]),
    });
    expect(result.rows).toEqual([{ rowNumber: 2, cells: ['First sheet', null] }]);
  });

  it('also captures existing binary XLS templates without changing row positions', () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([['Explanation'], ['Title', 'Project/Name'], [null, 'Project A']]),
      'Import',
    );
    const result = captureImportXlsxRequest({
      columns: columns(),
      buffer: XLSX.write(book, { type: 'buffer', bookType: 'biff8' }),
    });
    expect(result.rows).toEqual([{ rowNumber: 3, cells: [null, 'Project A'] }]);
  });

  it('detaches all column and workbook data from the caller', () => {
    const request = input();
    const result = captureImportXlsxRequest(request);
    request.columns[0].dataIndex[0] = 'changed';
    request.columns[1].enum[0].label = 'Changed project';
    request.buffer.fill(0);
    expect(result.fields).toEqual(['title', 'project.name']);
    expect(result.columns[0].dataIndex).toEqual(['title']);
    expect(result.columns[1].enum).toEqual([{ value: 42, label: 'Project A' }]);
    expect(result.rows).toEqual([{ rowNumber: 2, cells: ['Document', 'Project A'] }]);
  });

  it('accepts an empty data section without inventing a record', () => {
    expect(
      captureImportXlsxRequest({ columns: columns(), buffer: workbook([['Title', 'Project/Name']]) }).rows,
    ).toEqual([]);
  });

  it.each([
    [
      'missing template',
      [
        ['Wrong', 'Project/Name'],
        ['Document', 'Project A'],
      ],
    ],
    [
      'blank leading header column',
      [
        [null, 'Title', 'Project/Name'],
        ['Document', 'Project A'],
      ],
    ],
    [
      'unknown data column',
      [
        ['Title', 'Project/Name'],
        ['Document', 'Project A', 'Extra value'],
      ],
    ],
    [
      'repeated template',
      [
        ['Title', 'Project/Name'],
        ['Title', 'Project/Name'],
        ['Document', 'Project A'],
      ],
    ],
  ])('rejects %s instead of dropping or misaligning cells', (_, rows) => {
    expect(() => captureImportXlsxRequest({ columns: columns(), buffer: workbook(rows) })).toThrow(
      expect.objectContaining({ code: 'INVALID_IMPORT_REQUEST', status: 400 }),
    );
  });

  it.each(
    [
      undefined,
      'not JSON',
      [],
      [{ dataIndex: ['title'] }],
      [{ dataIndex: ['title'], defaultTitle: '' }],
      [{ dataIndex: ['__proto__'], defaultTitle: 'Title' }],
      [{ dataIndex: ['project', 'constructor'], defaultTitle: 'Title' }],
      [{ dataIndex: ['title'], defaultTitle: 'Title', script: 'not allowed' }],
      [{ dataIndex: ['title'], defaultTitle: 'Title', enum: [{ value: {}, label: 'Bad' }] }],
      [columns()[0], columns()[0]],
    ].map((value) => ({ value })),
  )('rejects invalid or ambiguous column configuration %j', ({ value }) => {
    expect(() => captureImportXlsxRequest({ ...input(), columns: value })).toThrow(
      expect.objectContaining({ code: 'INVALID_IMPORT_REQUEST', status: 400 }),
    );
  });

  it.each(['buffer', 'columns', 'dataIndex', 'array item', 'enum label'])(
    'rejects %s accessors without invoking them',
    (location) => {
      const request = input();
      let invoked = false;
      const getter = {
        enumerable: true,
        get() {
          invoked = true;
          throw new Error('Accessor ran');
        },
      };
      if (location === 'buffer') Object.defineProperty(request, 'buffer', getter);
      if (location === 'columns') Object.defineProperty(request, 'columns', getter);
      if (location === 'dataIndex') Object.defineProperty(request.columns[0], 'dataIndex', getter);
      if (location === 'array item') Object.defineProperty(request.columns, '0', getter);
      if (location === 'enum label') Object.defineProperty(request.columns[1].enum[0], 'label', getter);
      expect(() => captureImportXlsxRequest(request)).toThrow(
        expect.objectContaining({ code: 'INVALID_IMPORT_REQUEST', status: 400 }),
      );
      expect(invoked).toBe(false);
    },
  );

  it.each([undefined, Buffer.alloc(0), Buffer.from('PK\x03\x04invalid archive'), Buffer.alloc(20 * 1024 * 1024 + 1)])(
    'rejects missing, unreadable or oversized workbook input',
    (buffer) => {
      expect(() => captureImportXlsxRequest({ ...input(), buffer })).toThrow(
        expect.objectContaining({ code: 'INVALID_IMPORT_REQUEST', status: 400 }),
      );
    },
  );

  it.each(['xlsx', 'biff8'] as const)(
    'rejects excessive %s sheet ranges rather than returning truncated success',
    (bookType) => {
      const book = XLSX.utils.book_new();
      const sheet = XLSX.utils.aoa_to_sheet([
        ['Title', 'Project/Name'],
        ['Document', 'Project A'],
      ]);
      sheet.A10004 = { t: 's', v: 'Beyond limit' };
      sheet['!ref'] = 'A1:B10004';
      XLSX.utils.book_append_sheet(book, sheet, 'Import');
      expect(() =>
        captureImportXlsxRequest({ columns: columns(), buffer: XLSX.write(book, { type: 'buffer', bookType }) }),
      ).toThrow(expect.objectContaining({ code: 'INVALID_IMPORT_REQUEST', status: 400 }));
    },
  );

  it('accepts exactly ten thousand data rows and refuses an additional row without truncating', () => {
    const data = [['Title'], ...Array.from({ length: 10000 }, (_, index) => [`Document ${index + 1}`])];
    const singleColumn = [{ dataIndex: ['title'], defaultTitle: 'Title' }];
    const result = captureImportXlsxRequest({ columns: singleColumn, buffer: workbook(data) });
    expect(result.rows).toHaveLength(10000);
    expect(result.rows[0]).toEqual({ rowNumber: 2, cells: ['Document 1'] });
    expect(result.rows[9999]).toEqual({ rowNumber: 10001, cells: ['Document 10000'] });
    data.push(['Extra record']);
    expect(() => captureImportXlsxRequest({ columns: singleColumn, buffer: workbook(data) })).toThrow(
      expect.objectContaining({ code: 'INVALID_IMPORT_REQUEST', status: 400 }),
    );
  });

  it.each(['column count', 'enumeration count', 'path depth'])(
    'refuses excessive %s rather than dropping configured content',
    (kind) => {
      const selected =
        kind === 'column count'
          ? Array.from({ length: 201 }, (_, index) => ({
              dataIndex: [`field${index}`],
              defaultTitle: `Field ${index}`,
            }))
          : [
              {
                dataIndex: kind === 'path depth' ? ['a', 'b', 'c', 'd', 'e'] : ['title'],
                defaultTitle: 'Title',
                ...(kind === 'enumeration count'
                  ? { enum: Array.from({ length: 1001 }, (_, index) => ({ value: index, label: `Value ${index}` })) }
                  : {}),
              },
            ];
      expect(() =>
        captureImportXlsxRequest({
          columns: selected,
          buffer: workbook([selected.map((column) => column.defaultTitle)]),
        }),
      ).toThrow(expect.objectContaining({ code: 'INVALID_IMPORT_REQUEST', status: 400 }));
    },
  );

  it('preserves falsy enumeration values as values rather than treating them as missing', () => {
    const result = captureImportXlsxRequest({
      columns: [
        {
          dataIndex: ['title'],
          defaultTitle: 'Title',
          enum: [
            { value: 0, label: false },
            { value: false, label: null },
          ],
        },
      ],
      buffer: workbook([['Title'], ['Record']]),
    });
    expect(result.columns[0].enum).toEqual([
      { value: 0, label: false },
      { value: false, label: null },
    ]);
  });
});

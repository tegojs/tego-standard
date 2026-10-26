import * as XLSX from 'xlsx';

export type ImportXlsxCell = string | number | boolean | null;
export interface ImportXlsxColumn {
  dataIndex: string[];
  defaultTitle: string;
  title?: string | null;
  enum?: Array<{ value: ImportXlsxCell; label: ImportXlsxCell }>;
}
export interface ImportXlsxRow {
  /** One-based physical sheet row, including the template and explanation. */
  rowNumber: number;
  cells: ImportXlsxCell[];
}
export interface ImportXlsxRequest {
  columns: ImportXlsxColumn[];
  /** All uploaded column paths. The caller must authorize them before resolving values. */
  fields: string[];
  header: string[];
  rows: ImportXlsxRow[];
}

/** Internal protocol diagnostic. The selected HTTP adapter owns translation and presentation. */
export class ImportXlsxRequestError extends Error {
  readonly status = 400;
  readonly code = 'INVALID_IMPORT_REQUEST';
}

const MAX_COLUMNS = 200;
const MAX_ROWS = 10000;
const MAX_SHEET_ROWS = MAX_ROWS + 2;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

function invalid(message: string): never {
  throw new ImportXlsxRequestError(message);
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key))
  )
    invalid('Unsupported import request object');
  return value as Record<string, unknown>;
}

function data(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)
    invalid('Import request cannot contain accessors or hidden properties');
  return descriptor.value;
}

function array(value: unknown, limit: number): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > limit ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    invalid('Import arrays must be bounded and dense');
  return Array.from({ length: value.length }, (_, index) => {
    if (!Object.hasOwn(value, index)) invalid('Import arrays must be bounded and dense');
    return data(value, String(index));
  });
}

function scalar(value: unknown): value is ImportXlsxCell {
  return (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.length <= 100000)
  );
}

function columns(input: unknown): ImportXlsxColumn[] {
  if (typeof input === 'string') {
    if (input.length > 1000000) invalid('Import columns exceed size limits');
    try {
      input = JSON.parse(input);
    } catch {
      invalid('Import columns must contain valid JSON');
    }
  }
  const paths = new Set<string>();
  const result = array(input, MAX_COLUMNS).map((value) => {
    const record = object(value, ['dataIndex', 'defaultTitle', 'title', 'enum']);
    const path = array(data(record, 'dataIndex'), 4);
    if (
      !path.length ||
      path.some(
        (part) =>
          typeof part !== 'string' ||
          !/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(part) ||
          ['__proto__', 'prototype', 'constructor'].includes(part),
      )
    )
      invalid('Invalid import field path');
    const key = path.join('.');
    if (paths.has(key)) invalid('Import columns cannot repeat the same field path');
    paths.add(key);
    const defaultTitle = data(record, 'defaultTitle');
    if (typeof defaultTitle !== 'string' || !defaultTitle.trim() || defaultTitle.length > 1024)
      invalid('Import column titles must be nonempty bounded strings');
    const column: ImportXlsxColumn = { dataIndex: path as string[], defaultTitle };
    const title = data(record, 'title');
    if (title !== undefined) {
      if (title !== null && (typeof title !== 'string' || title.length > 1024)) invalid('Invalid import column title');
      column.title = title as string | null;
    }
    const enumeration = data(record, 'enum');
    if (enumeration !== undefined) {
      column.enum = array(enumeration, 1000).map((option) => {
        const entry = object(option, ['value', 'label']);
        const value = data(entry, 'value');
        const label = data(entry, 'label');
        if (!scalar(value) || !scalar(label)) invalid('Import enumerations must contain scalar values');
        return { value, label };
      });
    }
    return column;
  });
  if (!result.length) invalid('Select at least one import column');
  return result;
}

function nonempty(value: unknown): boolean {
  return value != null && (typeof value !== 'string' || value.trim() !== '');
}

/** Pure file protocol capture: no field parser, repository lookup, authorization or write. */
export function captureImportXlsxRequest(input: unknown): ImportXlsxRequest {
  const request = object(input, ['buffer', 'columns']);
  const selected = columns(data(request, 'columns'));
  const buffer = data(request, 'buffer');
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_FILE_BYTES)
    invalid('Import requires a nonempty workbook of at most 20 MiB');
  let sheet: XLSX.WorkSheet;
  let range: XLSX.Range;
  try {
    const book = XLSX.read(Buffer.from(buffer), { type: 'buffer', sheetRows: MAX_SHEET_ROWS + 1 });
    sheet = book.Sheets[book.SheetNames[0]];
    const reference = sheet?.['!fullref'] ?? sheet?.['!ref'];
    if (!reference) invalid('Imported spreadsheet has no template header');
    range = XLSX.utils.decode_range(reference);
  } catch (error) {
    if (error instanceof ImportXlsxRequestError) throw error;
    invalid('Unable to read imported spreadsheet');
  }
  if (range.e.r >= MAX_SHEET_ROWS || range.e.c >= MAX_COLUMNS) invalid('Imported sheet exceeds row or column limits');
  // SheetJS turns error cells into null; reject them before that loses values or entire rows.
  for (const address of Object.keys(sheet)) {
    if (!address.startsWith('!') && sheet[address]?.t === 'e')
      invalid('Imported spreadsheet contains an Excel error cell');
  }
  const matrix = XLSX.utils.sheet_to_json<ImportXlsxCell[]>(sheet, {
    header: 1,
    defval: null,
    raw: false,
    blankrows: true,
    range: { s: { r: 0, c: 0 }, e: range.e },
  });
  const header = selected.map((column) => column.defaultTitle);
  const matchesHeader = (row: ImportXlsxCell[]) =>
    header.every((title, index) => row[index] === title) && !row.slice(header.length).some(nonempty);
  const start = matrix.findIndex(matchesHeader);
  if (start < 0) invalid('Imported template does not match the selected columns');
  const rows: ImportXlsxRow[] = [];
  for (let index = start + 1; index < matrix.length; index++) {
    const row = matrix[index];
    if (!row.some(nonempty)) continue;
    if (matchesHeader(row)) invalid('Imported spreadsheet contains a repeated template header');
    if (row.slice(header.length).some(nonempty)) invalid('Imported row contains unmapped data columns');
    const cells = header.map((_, position) => row[position] ?? null);
    if (!cells.every(scalar)) invalid('Imported cells must contain bounded scalar display values');
    rows.push({ rowNumber: index + 1, cells });
    if (rows.length > MAX_ROWS) invalid('Imported spreadsheet exceeds the data row limit');
  }
  return { columns: selected, fields: selected.map((column) => column.dataIndex.join('.')), header, rows };
}

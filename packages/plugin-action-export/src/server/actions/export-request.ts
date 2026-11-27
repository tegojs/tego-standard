import { ExportColumnsError, normalizeExportColumns } from '../utils';

export interface ExportXlsxColumn {
  dataIndex: string[];
  title?: string | null;
  defaultTitle?: string | null;
  enum?: Array<{ value: string | number | boolean | null; label: string | number | boolean | null }>;
}

export interface ExportXlsxRequest {
  columns: ExportXlsxColumn[];
  title?: string;
  /** Original query controls plus displayed fields; the caller must validate and authorize these. */
  params: Record<string, unknown>;
}

/** Internal adapter diagnostic; the HTTP boundary owns localization and presentation. */
export class ExportXlsxRequestError extends Error {
  readonly status = 400;
  readonly code = 'INVALID_EXPORT_REQUEST';
}

function invalid(message: string): never {
  throw new ExportXlsxRequestError(message);
}

function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

/** Snapshot raw request JSON without executing getters or retaining caller-owned objects. */
function snapshot(input: unknown): unknown {
  let nodes = 0;
  const ancestors = new Set<object>();
  function copy(value: unknown, depth: number): unknown {
    if (++nodes > 10000 || depth > 16) invalid('Export request exceeds size or depth limits');
    if (typeof value === 'string') {
      if (value.length > 100000) invalid('Export request string exceeds size limits');
      return value;
    }
    if (value === undefined || value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || (!Array.isArray(value) && !plain(value)))
      invalid('Export request must contain plain JSON values');
    if (ancestors.has(value)) invalid('Export request cannot contain cycles');
    ancestors.add(value);
    const list = Array.isArray(value);
    if (
      list &&
      (Object.getPrototypeOf(value) !== Array.prototype ||
        value.length > 1000 ||
        Reflect.ownKeys(value).length !== value.length + 1)
    )
      invalid('Export request arrays must be bounded and dense');
    if (list) {
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) invalid('Export request arrays must be bounded and dense');
      }
    }
    const result = list ? [] : Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (list && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key !== 'string' || key.length > 1024 || !Object.hasOwn(descriptor, 'value'))
        invalid('Export request cannot contain accessors or invalid keys');
      Object.defineProperty(result, key, {
        value: copy(descriptor.value, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    ancestors.delete(value);
    return result;
  }
  return copy(input, 0);
}

function text(value: unknown): boolean {
  return value == null || (typeof value === 'string' && value.length <= 1024);
}

function scalar(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function fieldNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((name) => typeof name !== 'string' || !name || name.length > 1024))
    invalid('Export fields must contain bounded field names');
  return value;
}

/** File protocol only: this neither authorizes records nor alters the original export path. */
export function captureExportXlsxRequest(input: unknown): ExportXlsxRequest {
  const raw = snapshot(input);
  if (!plain(raw)) invalid('Export request must be an object');
  const { columns: queryColumns, title: queryTitle, values, ...params } = raw;
  if (values != null && (!plain(values) || Object.keys(values).some((key) => !['columns', 'title'].includes(key))))
    invalid('Unsupported export body values');
  const body = values as Record<string, unknown> | undefined;
  const title = queryTitle ?? body?.title;
  if (title !== undefined && (typeof title !== 'string' || title.length > 1024))
    invalid('Export title must be a bounded string');
  let columns: ExportXlsxColumn[];
  try {
    columns = snapshot(normalizeExportColumns(body?.columns ?? queryColumns)) as ExportXlsxColumn[];
  } catch (error) {
    if (error instanceof ExportColumnsError) invalid(error.message);
    throw error;
  }
  for (const column of columns) {
    if (
      Object.keys(column).some((key) => !['dataIndex', 'title', 'defaultTitle', 'enum'].includes(key)) ||
      column.dataIndex.length > 4 ||
      column.dataIndex.some(
        (part) =>
          !/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(part) || ['__proto__', 'prototype', 'constructor'].includes(part),
      ) ||
      !text(column.title) ||
      !text(column.defaultTitle)
    )
      invalid('Unsupported export column');
    if (
      column.enum !== undefined &&
      (!Array.isArray(column.enum) ||
        column.enum.some(
          (option) =>
            !plain(option) ||
            Object.keys(option).some((key) => !['value', 'label'].includes(key)) ||
            !scalar(option.value) ||
            !scalar(option.label),
        ))
    )
      invalid('Unsupported export column enumeration');
  }
  // The renderer must not become a way to access fields missing from the read decision.
  params.fields = [
    ...new Set([
      ...(params.fields === undefined ? [] : fieldNames(params.fields)),
      ...columns.map((column) => column.dataIndex.join('.')),
    ]),
  ];
  if (typeof params.appends === 'string') params.appends = params.appends === '' ? [] : params.appends.split(',');
  if (params.appends !== undefined) params.appends = fieldNames(params.appends);
  return { columns, title: title as string | undefined, params };
}

import type { AccessSelectedGetRequest, AccessSelectedListRequest } from './entry-reads';
import type { AccessReadRequest, AccessSumRequest } from './reads';
import { invalid, plain } from './write-support';

const selectionKeys = ['fields', 'appends', 'except'];

export interface AccessResourceListRequest extends AccessSelectedListRequest {
  limit: number;
  offset: number;
}

function names(input: unknown, sort = false): string[] {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length > (sort ? 20 : 1000) ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    invalid('Resource read fields must be bounded dense arrays');
  const result: string[] = [];
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, index);
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, 'value') ||
      typeof descriptor.value !== 'string' ||
      !descriptor.value ||
      descriptor.value.length > (sort ? 512 : 1024)
    )
      invalid('Resource read fields must contain bounded names without accessors');
    result.push(descriptor.value);
  }
  return result;
}

function capture(input: unknown, kind: 'list' | 'get' | 'count' | 'sum'): Record<string, unknown> {
  const allowed =
    kind === 'count' || kind === 'sum'
      ? ['filter', ...(kind === 'sum' ? ['field'] : [])]
      : [
          ...selectionKeys,
          'filter',
          ...(kind === 'list' ? ['sort', 'page', 'pageSize', 'paginate', 'tree'] : ['filterByTk']),
        ];
  if (
    !plain(input) ||
    Reflect.ownKeys(input).some(
      (key) =>
        typeof key !== 'string' ||
        !allowed.includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'),
    )
  )
    invalid('Unsupported resource read params');
  const result = Object.fromEntries(
    Reflect.ownKeys(input).map((key) => [key, Object.getOwnPropertyDescriptor(input, key)!.value]),
  );
  for (const key of selectionKeys) if (result[key] !== undefined) result[key] = names(result[key]);
  if (result.sort !== undefined) {
    if (typeof result.sort === 'string') {
      if (result.sort.length > 10260) invalid('Resource sort exceeds supported limits');
      result.sort = result.sort.split(',');
    }
    result.sort = names(result.sort, true);
  }
  return result;
}

function selection(params: Record<string, unknown>) {
  return Object.fromEntries(
    [...selectionKeys, 'filter', 'sort'].filter((key) => params[key] !== undefined).map((key) => [key, params[key]]),
  );
}

function positiveInteger(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value === 'string') {
    if (value.length > 16 || !/^[1-9]\d*$/.test(value)) invalid('Pagination requires a positive integer');
    value = Number(value);
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    invalid('Pagination requires a positive safe integer');
  return value;
}

/** Converts parsed action params only; callers separately provide trusted transaction and authorization. */
export function parseResourceListParams(input: unknown): AccessResourceListRequest {
  const params = capture(input, 'list');
  if (params.paginate !== undefined && params.paginate !== true && params.paginate !== 'true')
    invalid('Only paginated resource lists are supported');
  if (params.tree !== undefined && params.tree !== false && params.tree !== 'false')
    invalid('Tree resource lists require a dedicated adapter');
  const page = positiveInteger(params.page, 1);
  const limit = positiveInteger(params.pageSize, 20);
  const offset = (page - 1) * limit;
  if (limit > 1000 || !Number.isSafeInteger(offset) || offset > 1000000)
    invalid('Resource read pagination exceeds supported limits');
  return { ...selection(params), limit, offset };
}

export function parseResourceGetParams(input: unknown): AccessSelectedGetRequest & { key: string | number } {
  const params = capture(input, 'get');
  const key = params.filterByTk;
  if (
    !(typeof key === 'string' && key.length > 0 && key.length <= 512) &&
    !(typeof key === 'number' && Number.isSafeInteger(key))
  )
    invalid('Resource detail reads require an explicit scalar key');
  return { ...selection(params), key };
}

/** HasOne locates its target through the source relation; core ignores filterByTk for it. */
export function parseResourceAssociationGetParams(
  input: unknown,
  single: boolean,
): Omit<AccessSelectedGetRequest, 'key' | 'keyField'> & { key?: string | number } {
  if (!single) return parseResourceGetParams(input);
  const params = capture(input, 'get');
  if (params.filterByTk !== undefined && params.filterByTk !== null)
    parseResourceGetParams({ filterByTk: params.filterByTk });
  return selection(params);
}

export function parseResourceCountParams(input: unknown): Omit<AccessReadRequest, 'transaction'> {
  const params = capture(input, 'count');
  return params.filter === undefined ? {} : { filter: params.filter };
}

/** Internal root sum contract; not the generic repository aggregate action. */
export function parseResourceSumParams(input: unknown): Omit<AccessSumRequest, 'transaction'> {
  const params = capture(input, 'sum');
  if (typeof params.field !== 'string' || params.field.length > 512 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(params.field))
    invalid('Resource sum requires a bounded root field name');
  return { field: params.field, ...(params.filter === undefined ? {} : { filter: params.filter }) };
}

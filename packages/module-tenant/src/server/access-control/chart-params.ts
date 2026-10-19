import type { AccessAggregateOrder } from './aggregate-order';
import { captureAccessFilter } from './filter-input';
import { invalid, plain } from './write-support';

function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !plain(input) ||
    Reflect.ownKeys(input).some(
      (key) =>
        typeof key !== 'string' ||
        !keys.includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'),
    )
  )
    invalid('Unsupported chart params or descriptor');
  return Object.fromEntries(
    Reflect.ownKeys(input).map((key) => [key, Object.getOwnPropertyDescriptor(input, key)!.value]),
  );
}

function items(input: unknown, max: number): unknown[] {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length > max ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    invalid('Chart fields must use bounded dense arrays');
  const result: unknown[] = [];
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, index);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid('Chart arrays cannot contain accessors or holes');
    result.push(descriptor.value);
  }
  return result;
}

function selected(input: unknown, measure: boolean) {
  const params = record(input, ['field', 'alias', 'type', ...(measure ? ['aggregation'] : ['format'])]);
  const fields = Array.isArray(params.field) ? items(params.field, 1) : [params.field];
  const field = fields[0];
  if (fields.length !== 1 || typeof field !== 'string' || field.length > 255 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field))
    invalid('Chart statistics require a bounded root field name');
  const alias = params.alias === undefined ? field : params.alias;
  if (typeof alias !== 'string' || !alias.length || alias.length > 255 || alias.includes('\0'))
    invalid('Chart aliases must be bounded nonempty names');
  // Client type hints never determine database types, field permissions or output conversion.
  if (params.type !== undefined && (typeof params.type !== 'string' || params.type.length > 255))
    invalid('Unsupported chart type hint');
  if (!measure && params.format !== undefined && params.format !== '')
    invalid('Chart dimension formatting requires a dedicated adapter');
  return { field, alias, aggregation: params.aggregation };
}

function parseOrders(
  input: unknown,
  measures: ReturnType<typeof selected>[],
  dimensions: ReturnType<typeof selected>[],
) {
  const selectedFields = [...measures, ...dimensions];
  const seen = new Set<string>();
  return items(input === undefined ? [] : input, measures.length + 3).map((item): AccessAggregateOrder => {
    const params = record(item, ['field', 'alias', 'order']);
    const fields = Array.isArray(params.field) ? items(params.field, 1) : [params.field];
    const field = fields[0];
    if (
      fields.length !== 1 ||
      (field !== undefined &&
        (typeof field !== 'string' || !field.length || field.length > 255 || field.includes('\0')))
    )
      invalid('Chart order requires a selected field or alias');
    const candidates = selectedFields.filter((selection) =>
      params.alias === undefined
        ? field === selection.field || field === selection.alias
        : params.alias === selection.alias &&
          (field === undefined || field === selection.field || field === selection.alias),
    );
    if (candidates.length !== 1) invalid('Chart order must identify one selected field or alias');
    const selection = candidates[0];
    if (seen.has(selection.alias)) invalid('Chart order targets must be distinct');
    seen.add(selection.alias);
    const direction = params.order === undefined ? 'asc' : params.order;
    if (direction !== 'asc' && direction !== 'desc' && direction !== 'ASC' && direction !== 'DESC')
      invalid('Unsupported chart order direction');
    const index = measures.indexOf(selection);
    return index >= 0
      ? { by: 'value', index, direction: direction === 'asc' || direction === 'ASC' ? 'asc' : 'desc' }
      : { by: 'field', field: selection.field, direction: direction === 'asc' || direction === 'ASC' ? 'asc' : 'desc' };
  });
}

/** Internal subset of chart query values; routing, cache and trusted execution context belong to the caller. */
export function parseChartParams(input: unknown) {
  const params = record(input, ['measures', 'dimensions', 'orders', 'filter', 'limit']);
  const measures = items(params.measures, 10).map((input) => {
    const measure = selected(input, true);
    if (typeof measure.aggregation !== 'string' || !['avg', 'count', 'min', 'max', 'sum'].includes(measure.aggregation))
      invalid('Select a supported chart aggregate method');
    return { ...measure, aggregation: measure.aggregation };
  });
  if (!measures.length) invalid('Select one to ten chart aggregate measures');
  const dimensions = items(params.dimensions === undefined ? [] : params.dimensions, 3).map((item) =>
    selected(item, false),
  );
  if (
    new Set(dimensions.map((item) => item.field)).size !== dimensions.length ||
    new Set([...measures, ...dimensions].map((item) => item.alias)).size !== dimensions.length + measures.length
  )
    invalid('Chart grouping fields and output aliases must be distinct');
  const order = parseOrders(params.orders, measures, dimensions);
  const limit = params.limit === undefined ? 1000 : params.limit;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    invalid('Chart group limit exceeds supported limits');
  return {
    measures: measures.map((measure) => ({ field: measure.field, alias: measure.alias, method: measure.aggregation })),
    dimensions: dimensions.map(({ field, alias }) => ({ field, alias })),
    order,
    filter: captureAccessFilter(params.filter === undefined ? {} : params.filter),
    limit,
  };
}

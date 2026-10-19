import { parseChartParams } from './chart-params';
import { invalid, plain } from './write-support';

function capture(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !plain(input) ||
    Reflect.ownKeys(input).some(
      (key) =>
        typeof key !== 'string' ||
        !keys.includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'),
    )
  )
    invalid('Unsupported chart query params');
  return Object.fromEntries(
    Reflect.ownKeys(input).map((key) => [key, Object.getOwnPropertyDescriptor(input, key)!.value]),
  );
}

/** Validate the existing envelope, but never use client cache metadata to bypass live authorization. */
export function parseChartQueryParams(input: unknown) {
  const queryKeys = ['measures', 'dimensions', 'orders', 'filter', 'limit'];
  const params = capture(input, ['collection', 'dataSource', 'uid', 'cache', 'refresh', ...queryKeys]);
  const dataSource = params.dataSource === undefined ? 'main' : params.dataSource;
  const collection = params.collection;
  if (
    typeof dataSource !== 'string' ||
    !dataSource.length ||
    dataSource.length > 255 ||
    dataSource.includes('\0') ||
    typeof collection !== 'string' ||
    collection.length > 255 ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(collection) ||
    ['_', '__proto__', 'constructor', 'prototype'].includes(collection)
  )
    invalid('Chart query requires a data source and root collection name');
  if (
    (params.uid !== undefined &&
      (typeof params.uid !== 'string' || params.uid.length > 255 || params.uid.includes('\0'))) ||
    (params.refresh !== undefined && typeof params.refresh !== 'boolean')
  )
    invalid('Unsupported chart query metadata');
  if (params.cache !== undefined) {
    const cache = capture(params.cache, ['enabled', 'ttl']);
    if (
      (cache.enabled !== undefined && typeof cache.enabled !== 'boolean') ||
      (cache.ttl !== undefined &&
        (typeof cache.ttl !== 'number' ||
          !Number.isFinite(cache.ttl) ||
          cache.ttl < 0 ||
          cache.ttl * 1000 > Number.MAX_SAFE_INTEGER))
    )
      invalid('Unsupported chart cache metadata');
  }
  return {
    dataSource,
    collection,
    chart: parseChartParams(
      Object.fromEntries(queryKeys.filter((key) => Object.hasOwn(params, key)).map((key) => [key, params[key]])),
    ),
  };
}

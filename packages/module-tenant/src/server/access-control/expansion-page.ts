import type { Collection, Transaction } from '@tego/server';

import { cloneDeep, invalid, normalizeKeys, plain } from './write-support';

/** Internal pairing information; only values are projected into an entry response. */
export interface AccessExpansionRecord {
  readonly key: string;
  readonly values: Readonly<Record<string, unknown>>;
}

export type AccessExpansionValue = AccessExpansionRecord | readonly AccessExpansionRecord[] | null;

export function expansionRecords(value: AccessExpansionValue): readonly AccessExpansionRecord[] {
  return value === null ? [] : Array.isArray(value) ? value : [value as AccessExpansionRecord];
}

export function mapExpansionValue(
  value: AccessExpansionValue,
  project: (record: AccessExpansionRecord) => Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | readonly Readonly<Record<string, unknown>>[] | null {
  if (value === null) return null;
  if (Array.isArray(value)) return Object.freeze(value.map(project));
  return project(value as AccessExpansionRecord);
}

/** Validate original descriptors before copying. Wide internal key pages are not mutation inputs. */
export function captureExpansionRequest<
  T extends {
    sourceKeys: Array<string | number>;
    targetAttributes: string[];
    transaction?: Transaction;
  },
>(request: T, allowed: readonly string[], pairing: boolean): T {
  if (
    !plain(request) ||
    Reflect.ownKeys(request).some(
      (key) =>
        typeof key !== 'string' ||
        !allowed.includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(request, key)!, 'value'),
    )
  )
    invalid('Unsupported association expansion input');
  const copyArray = (name: 'sourceKeys' | 'targetAttributes', maximum: number) => {
    const input = request[name];
    if (
      !Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Array.prototype ||
      input.length > maximum ||
      Reflect.ownKeys(input).length !== input.length + 1
    )
      invalid('Expansion arrays must be bounded and dense');
    const values: unknown[] = [];
    for (let index = 0; index < input.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(input, index);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid('Expansion arrays cannot contain accessors');
      values.push(descriptor.value);
    }
    return values;
  };
  const sourceKeys = copyArray('sourceKeys', pairing ? 10000 : 1000);
  const targetAttributes = copyArray('targetAttributes', 1000);
  const transaction = request.transaction;
  const rest = Object.fromEntries(
    Reflect.ownKeys(request)
      .filter((key) => !['transaction', 'sourceKeys', 'targetAttributes'].includes(key as string))
      .map((key) => [key, Object.getOwnPropertyDescriptor(request, key)!.value]),
  );
  return { ...cloneDeep(rest), sourceKeys, targetAttributes, transaction } as T;
}

/** Normalize bounded keys in memory; SQL still executes once for the entire path. */
export function normalizeExpansionKeys(keys: Array<string | number>, collection: Collection): string[] {
  const result = new Set<string>();
  for (let index = 0; index < keys.length; index += 1000)
    for (const key of normalizeKeys(keys.slice(index, index + 1000), collection)) result.add(key);
  return [...result];
}

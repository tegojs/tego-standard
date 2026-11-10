import type { Collection } from '@tego/server';

import { captureAccessFilter } from './filter-input';
import { invalid, plain } from './write-support';

/** Flat root text searches only; the ordinary reader still enforces the final grant and G/V. */
export function captureRootTextSearch(
  collection: Collection,
  permission: { allowed: boolean; params: unknown },
  input: unknown,
  filter: unknown,
): unknown {
  if (!collection?.model) invalid('Root text search collection is unavailable');
  const search = captureAccessFilter(input);
  if (!plain(search) || Object.keys(search).some((key) => !['keywords', 'fields', 'isSearchAllFields'].includes(key)))
    invalid('Unsupported root text search');
  const strings = (value: unknown): string[] => {
    if (
      !Array.isArray(value) ||
      value.length > 100 ||
      value.some((item) => typeof item !== 'string' || item.length > 1000)
    )
      invalid('Root text search requires bounded string lists');
    return value;
  };
  const keywords = strings(search.keywords)
    .map((word) => word.trim())
    .filter(Boolean);
  if (keywords.length > 10) invalid('Root text search supports at most ten keywords');
  if (search.isSearchAllFields !== undefined && typeof search.isSearchAllFields !== 'boolean')
    invalid('Root text search field mode must be boolean');
  const requested = search.fields === undefined ? undefined : strings(search.fields);
  if (!permission.allowed || !plain(permission.params)) invalid('Root text search requires final list permission');
  const physical = Object.keys(collection.model.rawAttributes).filter(
    (name) => (collection.model.rawAttributes[name].type as { key?: string }).key !== 'VIRTUAL',
  );
  const allowed = permission.params.fields === undefined ? physical : strings(permission.params.fields);
  if (allowed.some((name) => !physical.includes(name))) invalid('Root text search permission fields are unavailable');
  const selected = requested && !search.isSearchAllFields ? requested : allowed;
  if (selected.some((name) => name.includes('.') || !allowed.includes(name)))
    invalid('Root text search field is not authorized');
  // Even an empty search validates its shape and explicit field permissions.
  if (!keywords.length) return filter;
  const clauses: Record<string, unknown>[] = [];
  for (const name of new Set(selected)) {
    const field = collection.getField(name);
    const type = field?.type;
    if (field?.options.isForeignKey) continue;
    const key = (collection.model.rawAttributes[name].type as { key?: string }).key;
    if (
      ['bigInt', 'double', 'integer', 'float'].includes(type) ||
      (!field && ['INTEGER', 'BIGINT', 'DOUBLE', 'FLOAT', 'DECIMAL', 'REAL'].includes(key ?? ''))
    ) {
      if (keywords.some((word) => !Number.isNaN(Number(word))))
        invalid('Numeric root searches require a dedicated adapter');
      continue;
    }
    if (['date', 'datetime', 'timestamp', 'json', 'jsonb', 'array'].includes(type))
      invalid('This root search field requires a dedicated adapter');
    // The original plugin does not search context, boolean or other non-searchable field types.
    if (!['string', 'text', 'uid', 'sequence'].includes(type)) continue;
    if (field.options.uiSchema?.['x-component'] === 'Select')
      invalid('Enum-label root searches require a dedicated adapter');
    for (const keyword of keywords) clauses.push({ [name]: { $includes: keyword } });
  }
  if (!clauses.length || clauses.length > 100) invalid('Root text search exceeds supported field limits');
  const predicate = { $or: clauses };
  return filter === undefined ? predicate : { $and: [captureAccessFilter(filter), predicate] };
}

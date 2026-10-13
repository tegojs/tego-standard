import { AccessRuleError, type ContextPath, type Scalar } from './types';

/** Normalize only authenticated server values; this does not authenticate a request. */
export function normalizeAccessContextValue(path: ContextPath, value: unknown): Scalar | Scalar[] {
  const many = path === 'tenant.ancestorIds' || path === 'tenant.descendantIds';
  const validId = (id: unknown) =>
    (typeof id === 'string' && id.length > 0 && id.length <= 10000) ||
    (typeof id === 'number' && Number.isSafeInteger(id));
  const valid = many
    ? Array.isArray(value) && value.length <= 1000 && value.every(validId)
    : path === 'role.name'
      ? typeof value === 'string' && value.length > 0 && value.length <= 256
      : validId(value);
  if (!valid) throw new AccessRuleError('MISSING_ACCESS_CONTEXT', `Missing or invalid trusted context: ${path}`);
  return many ? (value as Scalar[]).map(String) : String(value);
}

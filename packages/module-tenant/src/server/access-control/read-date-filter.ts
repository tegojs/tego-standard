import { getDateVars } from '@tego/server';

import { dateFilterOperators, normalizeDateFilterOperand, normalizeDateFilterTimezone } from './date-filter';
import { captureAccessFilter } from './filter-input';
import { invalid, plain } from './write-support';

/** Supplied by the server entry, independently of action params and authorization. */
export interface AccessReadDateContext {
  now: string;
  timezone: string;
}

/** Capture before metadata callbacks so later mutations cannot change the clock or UTC offset. */
export function captureReadDateContext(context: AccessReadDateContext): Readonly<AccessReadDateContext> {
  if (
    !plain(context) ||
    Reflect.ownKeys(context).length !== 2 ||
    ['now', 'timezone'].some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(context, key);
      return !descriptor || !Object.hasOwn(descriptor, 'value');
    })
  )
    invalid('Date context requires an explicit server clock and timezone');
  const now = context.now;
  const timezone = normalizeDateFilterTimezone(context.timezone);
  if (typeof now !== 'string' || !now.endsWith('Z')) invalid('Date context requires a UTC instant');
  normalizeDateFilterOperand('$dateOn', now, timezone);
  return Object.freeze({ now, timezone });
}

/** Resolve date shortcuts only; never interpret user variables, code or permission inputs. */
export function resolveReadDateFilter(
  filter: unknown,
  context: AccessReadDateContext,
  resolveFieldTimezone: (path: readonly string[]) => unknown = () => undefined,
): unknown {
  const input = captureAccessFilter(filter);
  const { now, timezone } = captureReadDateContext(context);
  const variables = getDateVars();
  const fieldZones = new Map<string, string>();
  const operand = (operator: string, value: unknown, path: readonly string[]) => {
    const key = JSON.stringify(path);
    if (!fieldZones.has(key)) {
      const fieldZone = resolveFieldTimezone(Object.freeze([...path]));
      fieldZones.set(key, normalizeDateFilterTimezone(fieldZone ?? timezone));
    }
    const zone = fieldZones.get(key)!;
    let variable = false;
    if (typeof value === 'string' && (value.includes('{{') || value.includes('}}'))) {
      const match = /^\{\{\s*\$(?:nDate|date)\.([A-Za-z0-9]+)\s*\}\}$/.exec(value);
      if (!match || !Object.hasOwn(variables, match[1])) invalid('Unsupported date shortcut');
      variable = true;
      const name = match[1] as keyof typeof variables;
      const resolver = variables[name];
      value =
        name === 'now'
          ? now
          : typeof resolver === 'function'
            ? resolver({ now, timezone: zone, field: undefined })
            : resolver;
    }
    if (variable && operator === '$dateBetween' && typeof value === 'string' && !value.endsWith('Z')) {
      const calendar = normalizeDateFilterOperand('$dateOn', value, zone);
      value = [calendar, calendar, '[]', zone];
    }
    // Array ranges get an explicit entry/field timezone, matching core parseFilter rather than bare parseDate.
    if (Array.isArray(value) && (value.length === 2 || value.length === 3))
      value = [value[0], value[1], value.length === 3 ? value[2] : '[]', zone];
    return normalizeDateFilterOperand(operator, value, zone);
  };
  const walk = (value: unknown, path: readonly string[]): unknown => {
    if (Array.isArray(value)) return value.map((child) => walk(child, path));
    if (!value || typeof value !== 'object') return value;
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, child] of Object.entries(value)) {
      const parts = key.split('.');
      const last = parts.at(-1)!;
      const next = [...path, ...parts.slice(0, -1)];
      result[key] = (dateFilterOperators as readonly string[]).includes(last)
        ? operand(last, child, next)
        : walk(child, ['$and', '$or', '$not'].includes(key) ? path : [...path, ...parts]);
    }
    return result;
  };
  return walk(input, []);
}

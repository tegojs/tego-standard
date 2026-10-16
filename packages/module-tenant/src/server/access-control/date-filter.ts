import { invalid } from './write-support';

export const dateFilterOperators = [
  '$dateOn',
  '$dateNotOn',
  '$dateBefore',
  '$dateNotBefore',
  '$dateAfter',
  '$dateNotAfter',
  '$dateBetween',
] as const;

export function normalizeDateFilterTimezone(value: unknown): string {
  const match = typeof value === 'string' && /^([+-])(\d{2}):(\d{2})$/.exec(value);
  if (!match || Number(match[2]) > 14 || Number(match[3]) > 59 || (match[2] === '14' && match[3] !== '00'))
    invalid('Date filters require a valid explicit UTC offset');
  return value as string;
}

function date(value: unknown, timezone: string): string {
  if (typeof value !== 'string' || value.length > 64) invalid('Date filters require bounded absolute date strings');
  const match =
    /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:[T ](\d{2})(?::(\d{2})(?::(\d{2})(?:\.(\d{3}))?)?)?)?)?)?(Z|[+-]\d{2}:\d{2})?$/.exec(
      value,
    );
  if (!match) invalid('Date filter value is unsupported or unresolved');
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
  const year = Number(yearText);
  const month = Number(monthText ?? 1);
  const day = Number(dayText ?? 1);
  if (
    year < 1000 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    Number(hourText ?? 0) > 23 ||
    Number(minuteText ?? 0) > 59 ||
    Number(secondText ?? 0) > 59 ||
    (zone === 'Z' && secondText === undefined)
  )
    invalid('Date filter value is not a valid calendar date');
  if (zone === 'Z') return value;
  const resolved = normalizeDateFilterTimezone(zone ?? timezone);
  return zone ? value : `${value}${resolved}`;
}

/** Freeze core date semantics without reading a clock, variables, headers or mutable request context. */
export function normalizeDateFilterOperand(operator: string, input: unknown, timezone = '+00:00'): string | string[] {
  if (!(dateFilterOperators as readonly string[]).includes(operator)) invalid('Unknown date filter operator');
  if (Array.isArray(input)) {
    if (
      Object.getPrototypeOf(input) !== Array.prototype ||
      input.length < 2 ||
      input.length > 4 ||
      Reflect.ownKeys(input).length !== input.length + 1
    )
      invalid('Date ranges require two dates and optional bounds and timezone');
    const values: unknown[] = [];
    for (let index = 0; index < input.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(input, index);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid('Date ranges cannot contain accessors or holes');
      values.push(descriptor.value);
    }
    const bounds = values.length >= 3 ? values[2] : '[]';
    if (typeof bounds !== 'string' || !['[]', '[)', '(]', '()'].includes(bounds)) invalid('Invalid date range bounds');
    // Core parseDateBetween uses UTC for arrays without their own fourth timezone item.
    const zone = normalizeDateFilterTimezone(values.length === 4 ? values[3] : '+00:00');
    return [date(values[0], zone), date(values[1], zone), bounds, zone];
  }
  if (typeof input === 'string' && (input.startsWith('[') || input.startsWith('('))) {
    if (input.length > 160) invalid('Date range exceeds size limit');
    const match = /^(\[|\()([^,]+),([^,]+)(\]|\))([+-]\d{2}:\d{2})?$/.exec(input);
    if (!match) invalid('Invalid absolute date range');
    const zone = normalizeDateFilterTimezone(match[5] ?? timezone);
    return [date(match[2], zone), date(match[3], zone), match[1] + match[4], zone];
  }
  if (operator === '$dateBetween') invalid('Date between requires an explicit range');
  return date(input, timezone);
}

import dayjs from 'dayjs';

import {
  isDatePickerDefaultRangeBoundaryValue,
  type DatePickerRangeValueMode,
  type DatePickerRangeValueSource,
} from '../date-picker/util';

/**
 * 筛选值为数组的操作符；与 transformToFilter 的 flatten breakOn、filterByCleanedFields 路径去重共用，避免两处列表漂移。
 */
export const FILTER_OPERATORS_WITH_ARRAY_VALUES = new Set<string>([
  '$match',
  '$notMatch',
  '$anyOf',
  '$noneOf',
  '$childIn',
  '$childNotIn',
  '$dateBetween',
  '$in',
  '$notIn',
]);

export type NormalizeDateBetweenOptions = {
  useDefaultDateBoundary?: boolean;
  valueMode?: DatePickerRangeValueMode;
  valueSource?: DatePickerRangeValueSource;
  preferDateBoundaryFallback?: boolean;
};

const getDatePickerComponent = (fieldSchema?: any) => {
  if (fieldSchema?.['x-component'] === 'CollectionField') {
    return fieldSchema?.['x-component-props']?.component;
  }
  return fieldSchema?.['x-component'] || fieldSchema?.['x-component-props']?.component;
};

const isDateOnlyString = (value: any) => {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
};

const hasExplicitTime = (value: any) => {
  return typeof value === 'string' && /[T\s]\d{2}:\d{2}/.test(value);
};

const normalizeLocalDateBoundaryInput = (value: any) => {
  if (typeof value !== 'string') {
    return value;
  }
  return value.replace(/Z$/, '').replace(/[+-]\d\d:\d\d$/, '');
};

const normalizeDateBetweenBoundary = (
  value: any,
  boundary: 'start' | 'end',
  options: NormalizeDateBetweenOptions = {},
) => {
  const m = dayjs(value);
  if (!m.isValid()) {
    return value;
  }

  if (isDateOnlyString(value)) {
    return (boundary === 'start' ? m.startOf('day') : m.endOf('day')).toISOString();
  }

  if (options.valueMode === 'date') {
    if (options.valueSource === 'metadata' || options.valueSource === 'retained-local-date-boundary') {
      return m.toISOString();
    }
    const localBoundary = dayjs(normalizeLocalDateBoundaryInput(value));
    return (boundary === 'start' ? localBoundary.startOf('day') : localBoundary.endOf('day')).toISOString();
  }

  if (hasExplicitTime(value)) {
    return m.toISOString();
  }

  if (!options.useDefaultDateBoundary) {
    return m.toISOString();
  }

  return (boundary === 'start' ? m.startOf('day') : m.endOf('day')).toISOString();
};

const shouldApplyDefaultDateBoundary = (
  start: any,
  end: any,
  value: any[],
  options: NormalizeDateBetweenOptions = {},
) => {
  if (options.valueMode === 'datetime') {
    return false;
  }
  if (options.valueMode === 'date') {
    return true;
  }
  if (!options.useDefaultDateBoundary) {
    return false;
  }
  if (isDateOnlyString(start) || isDateOnlyString(end)) {
    return true;
  }
  return (
    options.preferDateBoundaryFallback &&
    options.valueMode === 'date' &&
    isDatePickerDefaultRangeBoundaryValue(start, 'start') &&
    isDatePickerDefaultRangeBoundaryValue(end, 'end')
  );
};

export const normalizeDateBetweenValue = (value: any[], options: NormalizeDateBetweenOptions = {}) => {
  const normalized = value.filter(Boolean);
  if (normalized.length === 0) {
    return null;
  }

  const start = normalized[0];
  const end = normalized.length === 1 ? normalized[0] : normalized[normalized.length - 1];
  const boundaryOptions = {
    ...options,
    useDefaultDateBoundary: shouldApplyDefaultDateBoundary(start, end, value, options),
  };
  return [
    normalizeDateBetweenBoundary(start, 'start', boundaryOptions),
    normalizeDateBetweenBoundary(end, 'end', boundaryOptions),
  ];
};

export const shouldUseDefaultDateBoundary = (fieldSchema?: any) => {
  return getDatePickerComponent(fieldSchema) === 'DatePicker.RangePicker';
};

import { str2moment } from '@tego/client';

import dayjs from 'dayjs';
import { vi } from 'vitest';

import { mapRangePicker, moment2str, resolveDatePickerRangeValueInfo } from '../util';

describe('str2moment', () => {
  describe('string value', () => {
    test('gmt date', async () => {
      const m = str2moment('2022-06-21T00:00:00.000Z', { gmt: true });
      expect(m.format('YYYY-MM-DD HH:mm:ss')).toBe('2022-06-21 00:00:00');
    });

    test('local date', async () => {
      const m = str2moment('2022-06-21T00:00:00.000Z');
      expect(m.toISOString()).toBe('2022-06-21T00:00:00.000Z');
    });

    test('value is null', async () => {
      const m = str2moment(null);
      expect(m).toBeNull();
    });

    test('picker is month', async () => {
      const m = str2moment('2022-06-01T00:00:00.000Z', { picker: 'month' });
      expect(m.format('YYYY-MM-DD HH:mm:ss')).toBe('2022-06-01 00:00:00');
    });
  });

  describe('array value', () => {
    test('gmt date', async () => {
      const arr = str2moment(['2022-06-21T00:00:00.000Z', '2022-06-21T00:00:00.000Z'], { gmt: true });
      for (const m of arr) {
        expect(m.format('YYYY-MM-DD HH:mm:ss')).toBe('2022-06-21 00:00:00');
      }
    });

    test('local date', async () => {
      const arr = str2moment(['2022-06-21T00:00:00.000Z', '2022-06-21T00:00:00.000Z']);
      for (const m of arr) {
        expect(m.toISOString()).toBe('2022-06-21T00:00:00.000Z');
      }
    });
  });
});

describe('moment2str', () => {
  test('gmt date', () => {
    const m = dayjs('2023-06-21 10:10:00');
    const str = moment2str(m, { showTime: true, gmt: true });
    expect(str).toBe('2023-06-21T10:10:00.000Z');
  });

  test('showTime is true, gmt is false', () => {
    const m = dayjs('2023-06-21 10:10:00');
    const str = moment2str(m, { showTime: true, gmt: false });
    expect(str).toBe(m.toISOString());
  });

  test('gmt is true', () => {
    const m = dayjs('2023-06-21 10:10:00');
    const str = moment2str(m, { gmt: true });
    expect(str).toBe('2023-06-21T10:10:00.000Z');
  });

  test('gmt is false', () => {
    const m = dayjs('2023-06-21 10:10:00');
    const str = moment2str(m, { gmt: false });
    expect(str).toBe(dayjs('2023-06-21 10:10:00').toISOString());
  });

  test('with time', () => {
    const m = dayjs('2023-06-21 10:10:00');
    const str = moment2str(m, { showTime: true });
    expect(str).toBe(m.toISOString());
  });

  test('picker is year, gmt is false', () => {
    const m = dayjs('2023-06-21 10:10:00');
    const str = moment2str(m, { picker: 'year', gmt: false });
    expect(str).toBe(dayjs('2023-01-01 00:00:00').toISOString());
  });

  test('picker is year, gmt is true', () => {
    const m = dayjs('2023-06-21 10:10:00');
    const str = moment2str(m, { picker: 'year', gmt: true });
    expect(str).toBe('2023-01-01T00:00:00.000Z');
  });

  test('picker is year', () => {
    const m = dayjs('2023-06-21 10:10:00');
    const str = moment2str(m, { picker: 'year' });
    expect(str).toBe('2023-01-01T00:00:00.000Z');
  });

  test('picker is quarter, gmt is false', () => {
    const m = dayjs('2023-06-21 10:10:00');
    const str = moment2str(m, { picker: 'quarter', gmt: false });
    expect(str).toBe(dayjs('2023-04-01 00:00:00').toISOString());
  });

  test('picker is quarter, gmt is true', () => {
    const m = dayjs('2023-06-21 10:10:00');
    const str = moment2str(m, { picker: 'quarter', gmt: true });
    expect(str).toBe('2023-04-01T00:00:00.000Z');
  });

  test('picker is month, gmt is false', () => {
    const m = dayjs('2023-06-21 10:10:00');
    const str = moment2str(m, { picker: 'month', gmt: false });
    expect(str).toBe(dayjs('2023-06-01 00:00:00').toISOString());
  });

  test('picker is month, gmt is true', () => {
    const m = dayjs('2023-06-21 10:10:00');
    const str = moment2str(m, { picker: 'month', gmt: true });
    expect(str).toBe('2023-06-01T00:00:00.000Z');
  });

  test('picker is month', () => {
    const m = dayjs('2023-06-21 10:10:00');
    const str = moment2str(m, { picker: 'month' });
    expect(str).toBe('2023-06-01T00:00:00.000Z');
  });

  test('picker is week, gmt is false', () => {
    const m = dayjs('2023-06-21 10:10:00');
    const str = moment2str(m, { picker: 'week', gmt: false });
    expect(str).toBe(dayjs('2023-06-19 00:00:00').toISOString());
  });

  test('picker is week, gmt is true', () => {
    const m = dayjs('2023-06-21 10:10:00');
    const str = moment2str(m, { picker: 'week', gmt: true });
    expect(str).toBe('2023-06-19T00:00:00.000Z');
  });

  test('value is null', async () => {
    const m = moment2str(null);
    expect(m).toBeNull();
  });
});

describe('mapRangePicker', () => {
  test('should resolve retained date range mode from live metadata first', () => {
    let value: any[];
    const dateOnlyMapped = mapRangePicker()({
      showTime: false,
      utc: true,
      onChange: (nextValue: any[]) => {
        value = nextValue;
      },
    });
    dateOnlyMapped.onChange([dayjs('2026-05-01 00:00:00'), dayjs('2026-05-19 00:00:00')]);

    expect(resolveDatePickerRangeValueInfo(value, { showTime: true })).toEqual({
      mode: 'date',
      source: 'metadata',
    });
  });

  test('should resolve datetime range mode from live metadata before boundary fallback', () => {
    let value: any[];
    const datetimeMapped = mapRangePicker()({
      showTime: true,
      utc: true,
      onChange: (nextValue: any[]) => {
        value = nextValue;
      },
    });
    datetimeMapped.onChange([dayjs('2026-05-01 00:00:00'), dayjs('2026-05-19 23:59:59')]);

    expect(
      resolveDatePickerRangeValueInfo(value, {
        showTime: true,
        component: 'DatePicker.RangePicker',
        preferDateBoundaryFallback: true,
      }),
    ).toEqual({
      mode: 'datetime',
      source: 'metadata',
    });
  });

  test('should resolve unmarked retained range boundaries only when fallback is requested', () => {
    const value = ['2026-05-01T00:00:00.000Z', '2026-05-19T23:59:59.999Z'];

    expect(resolveDatePickerRangeValueInfo(value, { showTime: true })).toEqual({ source: 'unknown' });
    expect(
      resolveDatePickerRangeValueInfo(value, {
        showTime: true,
        component: 'DatePicker.RangePicker',
        preferDateBoundaryFallback: true,
      }),
    ).toEqual({
      mode: 'date',
      source: 'retained-date-boundary',
    });
  });

  test('should resolve original and converted retained range boundaries separately', () => {
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-480);

    expect(
      resolveDatePickerRangeValueInfo(['2026-05-01T00:00:00.000Z', '2026-05-19T23:59:59.999Z'], {
        showTime: true,
        component: 'DatePicker.RangePicker',
        preferDateBoundaryFallback: true,
      }),
    ).toEqual({
      mode: 'date',
      source: 'retained-date-boundary',
    });

    expect(
      resolveDatePickerRangeValueInfo(['2026-04-30T16:00:00.000Z', '2026-05-19T15:59:59.999Z'], {
        showTime: true,
        component: 'DatePicker.RangePicker',
        preferDateBoundaryFallback: true,
      }),
    ).toEqual({
      mode: 'date',
      source: 'retained-local-date-boundary',
    });

    expect(
      resolveDatePickerRangeValueInfo(['2026-05-01T16:00:00.000Z', '2026-05-03T15:59:59.999Z'], {
        component: 'DatePicker.RangePicker',
        preferDateBoundaryFallback: true,
      }),
    ).toEqual({
      mode: 'date',
      source: 'retained-local-date-boundary',
    });
  });

  test('should parse date-only range values with GMT semantics when gmt is not specified', () => {
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-480);

    const mapped = mapRangePicker()({
      value: ['2026-01-15T00:00:00.000Z', '2026-01-16T23:59:59.999Z'],
      showTime: false,
      utc: true,
    });

    expect(mapped.value[0].format('YYYY-MM-DD')).toBe('2026-01-15');
    expect(mapped.value[1].format('YYYY-MM-DD')).toBe('2026-01-16');
  });

  test('should keep retained date-only range values as local days after enabling showTime', () => {
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-480);

    let value: any[];
    const dateOnlyMapped = mapRangePicker()({
      showTime: false,
      utc: true,
      onChange: (nextValue: any[]) => {
        value = nextValue;
      },
    });
    dateOnlyMapped.onChange([dayjs('2026-05-01 00:00:00'), dayjs('2026-05-19 00:00:00')]);

    const mapped = mapRangePicker()({
      value,
      showTime: true,
      utc: true,
    });

    expect(mapped.value[0].format('YYYY-MM-DD HH:mm:ss')).toBe('2026-05-01 00:00:00');
    expect(mapped.value[1].format('YYYY-MM-DD HH:mm:ss')).toBe('2026-05-19 23:59:59');
  });

  test('should keep unmarked retained date-only range boundaries as local days after enabling showTime', () => {
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-480);

    const mapped = mapRangePicker()({
      value: ['2026-05-01T00:00:00.000Z', '2026-05-19T23:59:59.999Z'],
      showTime: true,
      utc: true,
    });

    expect(mapped.value[0].format('YYYY-MM-DD HH:mm:ss')).toBe('2026-05-01 00:00:00');
    expect(mapped.value[1].format('YYYY-MM-DD HH:mm:ss')).toBe('2026-05-19 23:59:59');
  });

  test('should keep converted ordinary retained date-only range boundaries as local days after enabling showTime', () => {
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-480);

    const mapped = mapRangePicker()({
      value: ['2026-04-30T16:00:00.000Z', '2026-05-19T15:59:59.999Z'],
      showTime: true,
      utc: true,
    });

    expect(mapped.value[0].format('YYYY-MM-DD HH:mm:ss')).toBe('2026-05-01 00:00:00');
    expect(mapped.value[1].format('YYYY-MM-DD HH:mm:ss')).toBe('2026-05-19 23:59:59');
  });

  test('should preserve explicit datetime range values after enabling showTime', () => {
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-480);

    const mapped = mapRangePicker()({
      value: ['2026-05-01T00:30:00.000Z', '2026-05-19T10:45:00.000Z'],
      showTime: true,
      utc: true,
    });

    expect(mapped.value[0].toISOString()).toBe('2026-05-01T00:30:00.000Z');
    expect(mapped.value[1].toISOString()).toBe('2026-05-19T10:45:00.000Z');
  });
});

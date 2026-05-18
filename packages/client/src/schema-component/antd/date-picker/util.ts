import { getDefaultFormat, str2moment, toGmt, toLocal } from '@tego/client';

import dayjs, { type Dayjs } from 'dayjs';

const getPickerStart = (value: Dayjs, picker?: any) => {
  if (picker === 'year') {
    return value.startOf('year');
  }
  if (picker === 'month') {
    return value.startOf('month');
  }
  if (picker === 'quarter') {
    return value.startOf('quarter');
  }
  if (picker === 'week') {
    return value.startOf('week').add(1, 'day').startOf('day');
  }
  return value.startOf('day');
};

const toLocalBoundaryByPicker = (value: Dayjs, picker?: any) => {
  if (!value || !dayjs.isDayjs(value)) {
    return value;
  }
  return getPickerStart(value, picker).toISOString();
};

export interface Moment2strOptions {
  showTime?: boolean;
  gmt?: boolean;
  utc?: boolean;
  picker?: 'year' | 'month' | 'week' | 'quarter';
}

export const normalizeDatePickerParseOptions = (options: Moment2strOptions = {}) => {
  if (options.utc === false || options.showTime || typeof options.gmt === 'boolean' || options.picker) {
    return options;
  }

  // For date-only values, the write path defaults to GMT strings.
  // Read path needs the same assumption, otherwise end-of-day values drift into the next local day.
  return {
    ...options,
    gmt: true,
  };
};

export const moment2str = (value?: Dayjs | null, options: Moment2strOptions = {}) => {
  const { showTime, gmt, picker, utc = true } = options;
  if (!value) {
    return value;
  }
  if (!utc) {
    const format = showTime ? 'YYYY-MM-DD HH:mm:ss' : 'YYYY-MM-DD';
    return value.format(format);
  }
  if (showTime) {
    return gmt ? toGmt(value) : toLocal(value);
  }
  return toLocalBoundaryByPicker(value, picker);
};

export const mapDatePicker = function () {
  return (props: any) => {
    const format = getDefaultFormat(props) as any;
    const onChange = props.onChange;

    return {
      ...props,
      format: format,
      value: str2moment(props.value, normalizeDatePickerParseOptions(props)),
      onChange: (value: Dayjs | null) => {
        if (onChange) {
          if (!props.showTime && value) {
            value = value.startOf('day');
          }
          onChange(moment2str(value, props));
        }
      },
    };
  };
};

export const mapRangePicker = function () {
  return (props: any) => {
    const format = getDefaultFormat(props) as any;
    const onChange = props.onChange;

    return {
      ...props,
      format: format,
      value: str2moment(props.value, normalizeDatePickerParseOptions(props)),
      onChange: (value: Dayjs[]) => {
        if (onChange) {
          onChange(value ? [rangeValue2str(value[0], props, 'start'), rangeValue2str(value[1], props, 'end')] : []);
        }
      },
    } as any;
  };
};

function rangeValue2str(value: Dayjs, options: Moment2strOptions, boundary: 'start' | 'end') {
  if (options.showTime || options.utc === false) {
    return moment2str(boundary === 'start' ? getRangeStart(value, options) : getRangeEnd(value, options), options);
  }
  return (boundary === 'start' ? getRangeStart(value, options) : getRangeEnd(value, options)).toISOString();
}

function getRangeStart(value: Dayjs, options: Moment2strOptions) {
  const { showTime } = options;
  if (showTime) {
    return value;
  }
  return value.startOf('day');
}

function getRangeEnd(value: Dayjs, options: Moment2strOptions) {
  const { showTime } = options;
  if (showTime) {
    return value;
  }
  return value.endOf('day');
}

const getStart = (offset: any, unit: any) => {
  return dayjs()
    .add(offset, unit === 'isoWeek' ? 'week' : unit)
    .startOf(unit);
};

const getEnd = (offset: any, unit: any) => {
  return dayjs()
    .add(offset, unit === 'isoWeek' ? 'week' : unit)
    .endOf(unit);
};

export const getDateRanges = () => {
  return {
    now: () => dayjs().toISOString(),
    today: () => [getStart(0, 'day'), getEnd(0, 'day')],
    yesterday: () => [getStart(-1, 'day'), getEnd(-1, 'day')],
    tomorrow: () => [getStart(1, 'day'), getEnd(1, 'day')],
    thisWeek: () => [getStart(0, 'isoWeek'), getEnd(0, 'isoWeek')],
    lastWeek: () => [getStart(-1, 'isoWeek'), getEnd(-1, 'isoWeek')],
    nextWeek: () => [getStart(1, 'isoWeek'), getEnd(1, 'isoWeek')],
    thisIsoWeek: () => [getStart(0, 'isoWeek'), getEnd(0, 'isoWeek')],
    lastIsoWeek: () => [getStart(-1, 'isoWeek'), getEnd(-1, 'isoWeek')],
    nextIsoWeek: () => [getStart(1, 'isoWeek'), getEnd(1, 'isoWeek')],
    thisMonth: () => [getStart(0, 'month'), getEnd(0, 'month')],
    lastMonth: () => [getStart(-1, 'month'), getEnd(-1, 'month')],
    nextMonth: () => [getStart(1, 'month'), getEnd(1, 'month')],
    thisQuarter: () => [getStart(0, 'quarter'), getEnd(0, 'quarter')],
    lastQuarter: () => [getStart(-1, 'quarter'), getEnd(-1, 'quarter')],
    nextQuarter: () => [getStart(1, 'quarter'), getEnd(1, 'quarter')],
    thisYear: () => [getStart(0, 'year'), getEnd(0, 'year')],
    lastYear: () => [getStart(-1, 'year'), getEnd(-1, 'year')],
    nextYear: () => [getStart(1, 'year'), getEnd(1, 'year')],
    last7Days: () => [getStart(-6, 'days'), getEnd(0, 'days')],
    next7Days: () => [getStart(1, 'day'), getEnd(7, 'days')],
    last30Days: () => [getStart(-29, 'days'), getEnd(0, 'days')],
    next30Days: () => [getStart(1, 'day'), getEnd(30, 'days')],
    last90Days: () => [getStart(-89, 'days'), getEnd(0, 'days')],
    next90Days: () => [getStart(1, 'day'), getEnd(90, 'days')],
  };
};

export const getDateExact = () => {
  return {
    nowUtc: () => dayjs().toISOString(),
    nowLocal: () => dayjs().format('YYYY-MM-DD HH:mm:ss'),
    todayUtc: () => dayjs().startOf('day').utc().toISOString(),
    todayLocal: () => dayjs().startOf('day').format('YYYY-MM-DD HH:mm:ss'),
    todayDate: () => dayjs().format('YYYY-MM-DD'),
    yesterdayUtc: () => dayjs().subtract(1, 'day').startOf('day').utc().toISOString(),
    yesterdayLocal: () => dayjs().subtract(1, 'day').startOf('day').format('YYYY-MM-DD HH:mm:ss'),
    yesterdayDate: () => dayjs().subtract(1, 'day').format('YYYY-MM-DD'),
    tomorrowUtc: () => dayjs().add(1, 'day').startOf('day').utc().toISOString(),
    tomorrowLocal: () => dayjs().add(1, 'day').startOf('day').format('YYYY-MM-DD HH:mm:ss'),
    tomorrowDate: () => dayjs().add(1, 'day').format('YYYY-MM-DD'),
  };
};

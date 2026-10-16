import { FilterParser, getDateVars, parseFilter, type Collection, type Database } from '@tego/server';

import { dateFilterOperators } from '../../access-control/date-filter';
import { resolveReadDateFilter } from '../../access-control/read-date-filter';
import { sqliteDatabase } from './database';

const clock = { now: '2026-09-16T00:00:00.000Z', timezone: '+08:00' };
const shortcuts = [
  'now',
  'today',
  'yesterday',
  'tomorrow',
  'thisWeek',
  'lastWeek',
  'nextWeek',
  'thisIsoWeek',
  'lastIsoWeek',
  'nextIsoWeek',
  'thisMonth',
  'lastMonth',
  'nextMonth',
  'thisQuarter',
  'lastQuarter',
  'nextQuarter',
  'thisYear',
  'lastYear',
  'nextYear',
  'last7Days',
  'next7Days',
  'last30Days',
  'next30Days',
  'last90Days',
  'next90Days',
];

describe('read entry date shortcuts', () => {
  let db: Database;
  let collection: Collection;
  beforeEach(() => {
    db = sqliteDatabase();
    collection = db.collection({ name: 'documents', timestamps: false, fields: [{ name: 'date', type: 'date' }] });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await db.close();
  });
  const where = (filter: unknown) => new FilterParser(filter, { collection }).toSequelizeParams().where;
  const core = (filter: unknown, context = clock, fieldTimezone?: string) =>
    parseFilter(filter, {
      ...context,
      vars: {
        $nDate: { ...getDateVars(), now: context.now },
        $date: { ...getDateVars(), now: context.now },
      },
      getField: () => ({ timezone: fieldTimezone }),
    });

  it.each(shortcuts)('matches core predicates for %s in both date namespaces', async (name) => {
    for (const namespace of ['$nDate', '$date'])
      for (const operator of dateFilterOperators) {
        if (name === 'now' && operator === '$dateBetween') continue;
        const filter = { date: { [operator]: `{{ ${namespace}.${name} }}` } };
        expect(where(resolveReadDateFilter(filter, clock))).toEqual(where(await core(filter)));
      }
  });
  it.each([
    { now: '2024-02-29T23:30:00.000Z', timezone: '+08:00' },
    { now: '2026-12-31T23:30:00.000Z', timezone: '-05:00' },
    { now: '2027-01-01T00:30:00.000Z', timezone: '+05:45' },
  ])('keeps the fixed clock across calendar boundaries: %j', async (context) => {
    for (const name of shortcuts.filter((value) => value !== 'now')) {
      const filter = { date: { $dateOn: `{{$nDate.${name}}}` } };
      expect(where(resolveReadDateFilter(filter, context))).toEqual(where(await core(filter, context)));
    }
  });
  it('uses field GMT for relative and absolute dates without overriding explicit offsets', async () => {
    for (const value of [
      ...shortcuts.filter((name) => /Week|Quarter/.test(name)).map((name) => `{{$nDate.${name}}}`),
      '{{$nDate.today}}',
      '2026-09-16',
      '2026-09-16+08:00',
      ['2026-09-16', '2026-09-17'],
    ]) {
      const filter = { date: { $dateOn: value } };
      expect(where(resolveReadDateFilter(filter, clock, () => '+00:00'))).toEqual(
        where(await core(filter, clock, '+00:00')),
      );
    }
  });
  it('resolves inside AND, OR, NOT and dotted association paths without changing structure', () => {
    const path = vi.fn(() => undefined);
    const filter = {
      $and: [
        { 'project.date': { $dateOn: '{{$date.today}}' } },
        { $or: [{ date: { $dateBefore: '{{$nDate.tomorrow}}' } }, { name: '{{$nDate.today}}' }] },
        { $not: { project: { date: { $dateAfter: '{{$nDate.yesterday}}' } } } },
      ],
    };
    expect(resolveReadDateFilter(filter, clock, path)).toEqual({
      $and: [
        { 'project.date': { $dateOn: '2026-09-16+08:00' } },
        { $or: [{ date: { $dateBefore: '2026-09-17+08:00' } }, { name: '{{$nDate.today}}' }] },
        { $not: { project: { date: { $dateAfter: '2026-09-15+08:00' } } } },
      ],
    });
    expect(path.mock.calls).toEqual([[['project', 'date']], [['date']]]);
  });
  it('captures context, filter and each field timezone before callbacks can change them', () => {
    const context = { ...clock };
    const filter = { date: { $dateOn: '{{$nDate.today}}', $dateBefore: '{{$nDate.tomorrow}}' } };
    const field = vi.fn(() => {
      context.now = '2030-01-01T00:00:00.000Z';
      context.timezone = '-05:00';
      filter.date.$dateOn = '{{$nDate.yesterday}}';
      return '+00:00';
    });
    expect(resolveReadDateFilter(filter, context, field)).toEqual({
      date: {
        $dateOn: '2026-09-16+00:00',
        $dateBefore: '2026-09-17+00:00',
      },
    });
    expect(field).toHaveBeenCalledTimes(1);
  });
  it('uses the supplied now for instant shortcuts instead of the real clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    expect(resolveReadDateFilter({ date: { $dateOn: '{{$nDate.now}}' } }, clock)).toEqual({
      date: { $dateOn: clock.now },
    });
  });
  it.each([
    '{{$nDate.unknown}}',
    '{{$nDate.constructor}}',
    '{{$nDate.__proto__}}',
    '{{$nDate.today()}}',
    'prefix {{$nDate.today}}',
    '{{$nDate.today}} suffix',
    '{{$user.id}}',
    '{{$nRole}}',
    '{{$nDate.thisweek}}',
    '{{$nDate.thisISOWeek}}',
    '{{$nDate.thisQuarter()}}',
    '{{$nDate.today',
    '$nDate.today}}',
  ])('rejects unsupported date templates instead of substituting NULL: %s', (value) => {
    expect(() => resolveReadDateFilter({ date: { $dateOn: value } }, clock)).toThrow();
  });
  it('rejects instant dateBetween while accepting a whole calendar unit shortcut', () => {
    expect(() => resolveReadDateFilter({ date: { $dateBetween: '{{$nDate.now}}' } }, clock)).toThrow();
    expect(resolveReadDateFilter({ date: { $dateBetween: '{{$nDate.thisMonth}}' } }, clock)).toEqual({
      date: {
        $dateBetween: ['2026-09+08:00', '2026-09+08:00', '[]', '+08:00'],
      },
    });
  });
  it.each([
    {},
    { now: clock.now },
    { ...clock, user: 28 },
    { ...clock, timezone: 'Asia/Shanghai' },
    { ...clock, timezone: '+15:00' },
    { ...clock, now: '2026-09-16' },
    { ...clock, now: '2026-02-29T00:00:00Z' },
    null,
  ])('rejects incomplete or invalid trusted date contexts: %j', (context) => {
    expect(() => resolveReadDateFilter({}, context as never)).toThrow();
  });
  it('rejects accessors without invoking them and rejects cyclic input', () => {
    const getter = vi.fn(() => clock.now);
    const context = Object.defineProperty({ timezone: '+08:00' }, 'now', { get: getter });
    expect(() => resolveReadDateFilter({}, context as never)).toThrow();
    expect(() => resolveReadDateFilter(Object.defineProperty({}, 'date', { get: getter }), clock)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const filter: Record<string, unknown> = {};
    filter.date = filter;
    expect(() => resolveReadDateFilter(filter, clock)).toThrow();
  });
  it('does not mutate absolute array ranges and rejects sparse arrays or array endpoint templates', () => {
    const range = ['2026-09-16', '2026-09-17'];
    expect(resolveReadDateFilter({ date: { $dateBetween: range } }, clock)).toEqual({
      date: { $dateBetween: ['2026-09-16+08:00', '2026-09-17+08:00', '[]', '+08:00'] },
    });
    expect(range).toEqual(['2026-09-16', '2026-09-17']);
    const sparse: string[] = [];
    sparse.length = 2;
    expect(() => resolveReadDateFilter({ date: { $dateBetween: sparse } }, clock)).toThrow();
    expect(() =>
      resolveReadDateFilter({ date: { $dateBetween: ['{{$nDate.today}}', '2026-09-17'] } }, clock),
    ).toThrow();
  });
});

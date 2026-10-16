import { FilterParser, Op, type Collection, type Database } from '@tego/server';

import { dateFilterOperators, normalizeDateFilterOperand } from '../../access-control/date-filter';
import { AccessRequestFilterParser } from '../../access-control/request-filter';
import { mainIdentity } from './config-database';
import { sqliteDatabase } from './database';

describe('absolute date filter operands', () => {
  let db: Database;
  let collection: Collection;
  beforeEach(() => {
    db = sqliteDatabase();
    collection = db.collection({
      name: 'documents',
      timestamps: false,
      fields: [
        { name: 'date', type: 'date' },
        { name: 'name', type: 'string' },
      ],
    });
    db.options.timezone = '+08:00';
  });
  afterEach(async () => db.close());
  const parser = () => new AccessRequestFilterParser(db, () => ({ identity: mainIdentity, fields: ['date', 'name'] }));
  const where = (operator: string, value: unknown) =>
    new FilterParser({ date: { [operator]: value } }, { collection }).toSequelizeParams().where;

  it.each(dateFilterOperators)('preserves the core %s predicate for explicit local dates', (operator) => {
    const value = operator === '$dateBetween' ? '[2026-09-16,2026-09-17]+08:00' : '2026-09-16+08:00';
    expect(parser().parse(mainIdentity, { date: { [operator]: value } }).filter).toEqual({
      type: 'predicate',
      where: where(operator, value),
    });
  });
  it.each(
    [
      '2026',
      '2026-09',
      '2026-09-16',
      '2026-09-16T12',
      '2026-09-16 12:34',
      '2026-09-16T12:34:56',
      '2026-09-16T12:34:56.789',
      '2026-09-16T12:34:56.789Z',
      '2024-02-29-05:30',
      '[2026-09-16,2026-09-17)',
      '(2026-09-16,2026-09-18]+05:45',
      ['2026-09-16', '2026-09-17'],
      ['2026-09-16', '2026-09-17', '[)'],
      ['2026-09-16', '2026-09-17', '[]', '+08:00'],
      ['2026-09-16T00:00:00.000Z', '2026-09-17T00:00:00.000Z', '(]'],
    ].map((value) => [value]),
  )('matches the core operand semantics: %j', (value) => {
    const normalized = normalizeDateFilterOperand('$dateOn', value, db.options.timezone);
    expect(where('$dateOn', normalized)).toEqual(where('$dateOn', value));
  });
  it('captures implicit timezone values independently of later database option changes', () => {
    const value = normalizeDateFilterOperand('$dateOn', '2026-09-16', '+08:00');
    db.options.timezone = '-05:00';
    expect(where('$dateOn', value)).toEqual(where('$dateOn', '2026-09-16+08:00'));
  });
  it('keeps core array UTC defaults and explicit array timezone overrides', () => {
    expect(normalizeDateFilterOperand('$dateBetween', ['2026-09-16', '2026-09-17'], '+08:00')).toEqual([
      '2026-09-16+00:00',
      '2026-09-17+00:00',
      '[]',
      '+00:00',
    ]);
    expect(normalizeDateFilterOperand('$dateBetween', ['2026-09-16', '2026-09-17', '[]', '+08:00'])).toEqual([
      '2026-09-16+08:00',
      '2026-09-17+08:00',
      '[]',
      '+08:00',
    ]);
  });
  it('captures the implicit timezone before permission callbacks run', () => {
    const changing = new AccessRequestFilterParser(db, () => {
      db.options.timezone = '-05:00';
      return { identity: mainIdentity, fields: ['date'] };
    });
    expect(changing.parse(mainIdentity, { date: { $dateOn: '2026-09-16' } }).filter).toEqual({
      type: 'predicate',
      where: where('$dateOn', '2026-09-16+08:00'),
    });
  });
  it('retains existing scalar operators alongside normalized dates', () => {
    const input = { date: { $dateOn: '2026-09-16', $lt: '2026-09-16T00:00:00.000Z' } };
    const expected = { [Op.and]: [where('$dateOn', '2026-09-16+08:00'), where('$lt', input.date.$lt)] };
    expect(parser().parse(mainIdentity, input).filter).toEqual({ type: 'predicate', where: expected });
    expect(input.date.$dateOn).toBe('2026-09-16');
  });
  it.each(['[]', '[)', '(]', '()'])('preserves core instant range behavior for %s bounds', (bounds) => {
    const input = ['2026-09-16T00:00:00Z', '2026-09-17T00:00:00Z', bounds];
    for (const operator of dateFilterOperators) {
      expect(parser().parse(mainIdentity, { date: { [operator]: input } }).filter).toEqual({
        type: 'predicate',
        where: where(operator, input),
      });
    }
    expect(input).toEqual(['2026-09-16T00:00:00Z', '2026-09-17T00:00:00Z', bounds]);
  });
  it.each(
    [
      '',
      null,
      true,
      2026,
      {},
      'today',
      '{{$nDate.today}}',
      '2026Q3',
      '2026W38',
      '2026w38',
      '0099-01-01',
      '2026-00-01',
      '2026-13-01',
      '2026-02-29',
      '2026-04-31',
      '2026-09-00',
      '2026-09-16T24:00:00',
      '2026-09-16T12:60:00',
      '2026-09-16T12:00:60',
      '2026-09-16T12:00:00.1',
      '2026-09-16Z',
      '2026-09-16+15:00',
      '2026-09-16+14:30',
      '2026-09-16+08:60',
      '[2026-09-16,invalid]',
      '[2026-09-16,2026-09-17,2026-09-18]',
      [],
      ['2026-09-16'],
      ['2026-09-16', null],
      ['2026-09-16', '2026-09-17', 'bad'],
      ['2026-09-16', '2026-09-17', '[]', 'Asia/Shanghai'],
      ['2026-09-16', '2026-09-17', '[]', '+08:00', 'extra'],
    ].map((value) => [value]),
  )('rejects unsupported or invalid date operands: %j', (value) => {
    expect(() => normalizeDateFilterOperand('$dateOn', value, '+08:00')).toThrow();
  });
  it('rejects scalar dateBetween values and unknown operators', () => {
    expect(() => normalizeDateFilterOperand('$dateBetween', '2026-09-16')).toThrow();
    expect(() => normalizeDateFilterOperand('$unknown', '2026-09-16')).toThrow();
  });
  it('does not accept date operators on non-date or unauthorized fields', () => {
    expect(() => parser().parse(mainIdentity, { name: { $dateOn: '2026-09-16' } })).toThrow();
    const denied = new AccessRequestFilterParser(db, () => ({ identity: mainIdentity, fields: ['name'] }));
    expect(() => denied.parse(mainIdentity, { date: { $dateOn: '2026-09-16' } })).toThrow(/authorized/);
  });
  it('rejects accessors and sparse range arrays without executing them', () => {
    const getter = vi.fn(() => '2026-09-16');
    const input = ['2026-09-16', '2026-09-17'];
    Object.defineProperty(input, '0', { get: getter });
    expect(() => normalizeDateFilterOperand('$dateBetween', input)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const sparse: string[] = [];
    sparse.length = 2;
    expect(() => normalizeDateFilterOperand('$dateBetween', sparse)).toThrow();
  });
});

import type { Collection, Database } from '@tego/server';

import { captureReadKey } from '../../access-control/read-key';
import { sqliteDatabase } from './database';

describe('detail read target keys', () => {
  let db: Database;
  let collection: Collection;
  beforeEach(() => {
    db = sqliteDatabase();
    collection = db.collection({
      name: 'keyed_documents',
      autoGenId: false,
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'number', type: 'string', field: 'business_number' },
        { name: 'memo', type: 'text' },
        { name: 'sequence', type: 'bigInt' },
        { name: 'uid', type: 'uuid' },
        { name: 'date', type: 'date' },
        { name: 'payload', type: 'json' },
        { name: 'computed', type: 'virtual' },
      ],
    });
  });
  afterEach(async () => {
    await db.close();
  });
  const capture = (field: string, value: unknown) => {
    collection.options.filterTargetKey = field;
    return captureReadKey(collection, value, field);
  };

  it('uses the effective configured attribute rather than its physical column name', () => {
    const plan = capture('number', 'Lease-001');
    expect(plan.field).toBe('number');
    expect(plan.value).toBe('Lease-001');
    expect(() => plan.assertCurrent()).not.toThrow();
  });
  it('preserves bounded long business text keys', () => {
    expect(capture('memo', 'x'.repeat(512)).value).toBe('x'.repeat(512));
    expect(() => capture('memo', 'x'.repeat(513))).toThrow();
  });
  it.each(['0012', '-0012', '9007199254740993'])('normalizes integer strings without precision loss (%s)', (value) => {
    expect(capture('sequence', value).value).toBe(BigInt(value).toString());
  });
  it('preserves the business UUID value for database comparison', () => {
    expect(capture('uid', 'A2563110-3782-4F23-B0AB-190317CC1B12').value).toBe('A2563110-3782-4F23-B0AB-190317CC1B12');
  });
  it('matches the core UUID lookup on databases that store UUID text verbatim', async () => {
    const uuid = 'A2563110-3782-4F23-B0AB-190317CC1B12';
    collection.options.filterTargetKey = 'uid';
    await collection.model.sync();
    await collection.model.create({ id: 1, uid: uuid });
    expect((await db.getRepository(collection.name).findOne({ filterByTk: uuid })).get('id')).toBe(1);
    const locator = captureReadKey(collection, uuid, 'uid');
    expect((await collection.model.findOne({ where: { [locator.field]: locator.value } }))?.get('id')).toBe(1);
  });
  it.each([null, undefined, {}, [], true, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, '', 'x'.repeat(513)])(
    'rejects unsupported key values %j',
    (value) => {
      expect(() => capture('number', value)).toThrow();
    },
  );
  it.each(['1.5', ' 1', '+1', '1e1'])('rejects non-integer business sequence %s', (value) => {
    expect(() => capture('sequence', value)).toThrow();
  });
  it('rejects numbers for a string business key', () => {
    expect(() => capture('number', 12)).toThrow();
    expect(capture('sequence', 12).value).toBe('12');
  });
  it.each(['date', 'payload', 'computed', 'missing'])('rejects unsupported target attributes %s', (field) => {
    expect(() => capture(field, '1')).toThrow();
  });
  it('rejects caller-selected fields that differ from the configured target', () => {
    collection.options.filterTargetKey = 'number';
    expect(() => captureReadKey(collection, '12', 'sequence')).toThrow(/target key/);
  });
  it('rejects target configuration changes after capture', () => {
    const plan = capture('number', 'Lease-001');
    collection.options.filterTargetKey = 'memo';
    expect(() => plan.assertCurrent()).toThrow(/target key/);
  });
  it('preserves primary-key behavior when no target attribute is provided', () => {
    collection.options.filterTargetKey = 'number';
    const plan = captureReadKey(collection, '0012');
    expect(plan.field).toBe('id');
    expect(plan.value).toBe('12');
  });
  it('preserves the existing primary-key length limit', () => {
    collection.setField('id', { type: 'text', primaryKey: true });
    expect(() => captureReadKey(collection, 'x'.repeat(256))).toThrow();
  });
  it('rejects composite primary keys even when a business target is configured', () => {
    collection.setField('second', { type: 'integer', primaryKey: true });
    expect(() => capture('number', 'Lease-001')).toThrow(/single primary/);
  });
});

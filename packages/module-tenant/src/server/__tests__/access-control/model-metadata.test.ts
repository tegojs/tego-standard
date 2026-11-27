import { literal, Op, type Collection, type Database } from '@tego/server';

import { compileAccessScopes } from '../../access-control/compile';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { queryRows, sqliteDatabase } from './database';
import { configFor, quoteIdentifier } from './fixtures';

describe('access rule real model metadata', () => {
  let db: Database;
  let docs: Collection;
  let people: Collection;

  beforeEach(async () => {
    db = sqliteDatabase();
    docs = db.collection({
      name: 'documents',
      tableName: 'document_rows',
      timestamps: false,
      fields: [
        { name: 'code', type: 'string', unique: true, field: 'document_code' },
        { name: 'tenantId', type: 'string', field: 'tenant_id' },
        { name: 'enabled', type: 'boolean' },
      ],
    });
    people = db.collection({
      name: 'people',
      timestamps: true,
      paranoid: true,
      fields: [
        { name: 'documentCode', type: 'string', field: 'document_code' },
        { name: 'businessTenant', type: 'string', field: 'business_tenant' },
        { name: 'canView', type: 'boolean' },
      ],
    });
    docs.setField('people', { type: 'hasMany', target: 'people', sourceKey: 'code', foreignKey: 'documentCode' });
    people.setField('document', {
      type: 'belongsTo',
      target: 'documents',
      foreignKey: 'documentCode',
      targetKey: 'code',
    });
    await db.sync();
    await docs.repository.create({
      values: [
        { id: 1, code: 'A', tenantId: 'H', enabled: true },
        { id: 2, code: 'B', tenantId: 'H', enabled: false },
      ],
    });
    await people.repository.create({
      values: [
        { id: 1, documentCode: 'A', businessTenant: 'B', canView: true },
        { id: 2, documentCode: 'B', businessTenant: 'B', canView: false },
      ],
    });
  });

  afterEach(async () => {
    await db.close();
  });

  const key = (collection: Collection) => `main:stable-${collection.name}`;
  function metadata(collection = docs) {
    return resolveModelMetadata(collection, { resolveCollectionKey: key });
  }
  async function readPeople() {
    const config = configFor({ type: 'exists', path: 'people', condition: { type: 'constant', value: true } });
    const read = compileAccessScopes(config, { collection: metadata(), context: {}, quoteIdentifier }).read;
    return (
      await queryRows<{ id: number }>(db, `SELECT id FROM document_rows AS tac_root WHERE ${read.sql} ORDER BY id`, {
        bind: read.bind,
      })
    ).map((row) => row.id);
  }

  it('maps physical tables, columns and stable collection keys', () => {
    const root = metadata();
    expect(root.key).toBe('main:stable-documents');
    expect(root.table).toEqual(['document_rows']);
    expect(root.fields.tenantId.column).toBe('tenant_id');
    expect(root.associations.people.sourceField).toBe('code');
    expect(root.associations.people.targetField).toBe('documentCode');
    expect(root.associations.people.target.associations.document.target).toBe(root);
  });

  it('executes custom source and target keys in both directions', async () => {
    expect(await readPeople()).toEqual([1, 2]);
    const read = compileAccessScopes(
      configFor({
        type: 'exists',
        path: 'document',
        condition: {
          type: 'compare',
          operator: 'eq',
          left: { type: 'field', path: 'code' },
          right: { type: 'literal', value: 'A' },
        },
      }),
      { collection: metadata(people), context: {}, quoteIdentifier },
    ).read;
    const rows = await queryRows<{ id: number }>(db, `SELECT id FROM people AS tac_root WHERE ${read.sql}`, {
      bind: read.bind,
    });
    expect(rows.map((row) => row.id)).toEqual([1]);
  });

  it('excludes soft deleted authorization facts', async () => {
    await people.model.destroy({ where: { id: 1 } });
    expect(await readPeople()).toEqual([2]);
  });

  it('preserves fixed association scope', async () => {
    docs.setField('people', {
      type: 'hasMany',
      target: 'people',
      sourceKey: 'code',
      foreignKey: 'documentCode',
      scope: { canView: true },
    });
    expect(await readPeople()).toEqual([1]);
  });

  it('preserves root default scope even with an unrestricted access rule', async () => {
    docs.model.addScope('defaultScope', { where: { enabled: true } }, { override: true });
    const scope = compileAccessScopes(configFor({ type: 'constant', value: true }), {
      collection: metadata(),
      context: {},
      quoteIdentifier,
    }).read;
    const rows = await queryRows<{ id: number }>(db, `SELECT id FROM document_rows AS tac_root WHERE ${scope.sql}`, {
      bind: scope.bind,
    });
    expect(rows.map((row) => row.id)).toEqual([1]);
  });

  it('preserves target scope and explicit Sequelize operators', async () => {
    people.model.addScope(
      'defaultScope',
      { where: { [Op.and]: [{ businessTenant: { [Op.in]: ['B'] } }, { canView: true }] } },
      { override: true },
    );
    expect(await readPeople()).toEqual([1]);
  });

  it('preserves object-form OR scopes instead of silently using AND', async () => {
    people.model.addScope(
      'defaultScope',
      { where: { [Op.or]: { canView: true, businessTenant: 'C' } } },
      { override: true },
    );
    expect((await people.model.findAll()).map((row) => row.get('id'))).toEqual([1]);
    expect(await readPeople()).toEqual([1]);
  });

  it.each([
    { [Op.or]: [{}, { canView: true }] },
    { [Op.or]: [{ [Op.and]: [] }, { canView: true }] },
    { [Op.not]: {} },
    { [Op.and]: [] },
  ])('preserves ignored empty scope groups without widening OR %#', async (where) => {
    people.model.addScope('defaultScope', { where }, { override: true });
    const expected = (await people.model.findAll({ order: ['id'] })).map((row) =>
      row.get('documentCode') === 'A' ? 1 : 2,
    );
    expect(await readPeople()).toEqual(expected);
  });

  it('uses hasOne keys without multiplying root records', async () => {
    docs.setField('onePerson', { type: 'hasOne', target: 'people', sourceKey: 'code', foreignKey: 'documentCode' });
    const root = metadata();
    expect(root.associations.onePerson.sourceField).toBe('code');
    expect(root.associations.onePerson.targetField).toBe('documentCode');
  });

  it('preserves many-to-many link scope and soft deletion', async () => {
    const links = db.collection({
      name: 'links',
      paranoid: true,
      fields: [
        { name: 'documentId', type: 'bigInt' },
        { name: 'personId', type: 'bigInt' },
        { name: 'active', type: 'boolean' },
      ],
    });
    docs.setField('linked', {
      type: 'belongsToMany',
      target: 'people',
      through: 'links',
      foreignKey: 'documentId',
      otherKey: 'personId',
      throughScope: { active: true },
    });
    await db.sync();
    await links.repository.create({
      values: [
        { id: 1, documentId: 1, personId: 1, active: true },
        { id: 2, documentId: 2, personId: 2, active: false },
      ],
    });
    const config = configFor({ type: 'exists', path: 'linked', condition: { type: 'constant', value: true } });
    const select = async () => {
      const read = compileAccessScopes(config, { collection: metadata(), context: {}, quoteIdentifier }).read;
      return queryRows<{ id: number }>(db, `SELECT id FROM document_rows AS tac_root WHERE ${read.sql}`, {
        bind: read.bind,
      });
    };
    expect(await select()).toEqual([{ id: 1 }]);
    await links.model.destroy({ where: { documentId: 1, personId: 1 } });
    expect(await select()).toEqual([]);
  });

  it('rejects unsupported expressions instead of dropping a fixed condition', () => {
    docs.model.addScope('defaultScope', { where: literal('enabled = 1') }, { override: true });
    expect(() => metadata()).toThrow(/scope/i);
  });

  it('rejects non-where default scope options that change the query set', () => {
    docs.model.addScope('defaultScope', { limit: 1 }, { override: true });
    expect(() => metadata()).toThrow(/scope/i);
  });

  it('only resolves associations actually used by rules', async () => {
    people.model.addScope('defaultScope', { where: literal('canView = 1') }, { override: true });
    const root = metadata();
    expect(() =>
      compileAccessScopes(configFor({ type: 'constant', value: true }), {
        collection: root,
        context: {},
        quoteIdentifier,
      }),
    ).not.toThrow();
    await expect(readPeople()).rejects.toThrow(/scope/i);
  });

  it('rejects a missing stable identifier', () => {
    expect(() => resolveModelMetadata(docs, { resolveCollectionKey: () => '' })).toThrow(/key|identifier/i);
  });

  it('rejects unverified database dialects before producing a plan', () => {
    const dialect = vi.spyOn(db.sequelize, 'getDialect').mockReturnValue('mysql');
    try {
      expect(() => metadata()).toThrow(/dialect/i);
    } finally {
      dialect.mockRestore();
    }
  });

  it('rejects unsupported field types rather than comparing their JSON as text', () => {
    docs.setField('details', { type: 'json' });
    expect(() =>
      compileAccessScopes(
        configFor({
          type: 'compare',
          operator: 'eq',
          left: { type: 'field', path: 'details' },
          right: { type: 'literal', value: 'B' },
        }),
        { collection: metadata(), context: {}, quoteIdentifier },
      ),
    ).toThrow(/field/i);
  });

  it('uses the actual dialect date format for bound comparisons', async () => {
    docs.setField('effectiveAt', { type: 'date' });
    await db.sync();
    await docs.model.update({ effectiveAt: '2026-10-13T02:00:00.000Z' }, { where: { id: 1 } });
    const scope = compileAccessScopes(
      configFor({
        type: 'compare',
        operator: 'eq',
        left: { type: 'field', path: 'effectiveAt' },
        right: { type: 'literal', value: '2026-10-13T10:00:00+08:00' },
      }),
      { collection: metadata(), context: {}, quoteIdentifier },
    ).read;
    const rows = await queryRows<{ id: number }>(db, `SELECT id FROM document_rows AS tac_root WHERE ${scope.sql}`, {
      bind: scope.bind,
    });
    expect(rows).toEqual([{ id: 1 }]);
  });

  it('rejects a duplicate stable key on a used target', async () => {
    const root = resolveModelMetadata(docs, { resolveCollectionKey: () => 'same' });
    expect(() => root.associations.people).toThrow(/identifier/i);
  });

  it('rejects a foreign database association even when the table name matches', async () => {
    const remote = sqliteDatabase();
    try {
      const other = remote.collection({ name: 'people', fields: [{ name: 'documentCode', type: 'string' }] });
      docs.model.hasMany(other.model, {
        as: 'foreignPeople',
        foreignKey: 'documentCode',
        sourceKey: 'code',
        constraints: false,
      });
      expect(() => metadata().associations.foreignPeople).toThrow(/database|unregistered/i);
    } finally {
      await remote.close();
    }
  });

  it('excludes soft deleted roots with unrestricted ownership rules', async () => {
    await people.model.destroy({ where: { id: 1 } });
    const scope = compileAccessScopes(configFor({ type: 'constant', value: true }), {
      collection: metadata(people),
      context: {},
      quoteIdentifier,
    }).ownership;
    expect(await queryRows(db, `SELECT id FROM people AS tac_root WHERE ${scope.sql}`, { bind: scope.bind })).toEqual([
      { id: 2 },
    ]);
  });

  it('supports numeric ordering on ordinary integer fields', async () => {
    docs.setField('amount', { type: 'integer' });
    await db.sync();
    await docs.model.update({ amount: 200 }, { where: { id: 2 } });
    const scope = compileAccessScopes(
      configFor({
        type: 'compare',
        operator: 'gte',
        left: { type: 'field', path: 'amount' },
        right: { type: 'literal', value: 100 },
      }),
      { collection: metadata(), context: {}, quoteIdentifier },
    ).ownership;
    expect(
      await queryRows(db, `SELECT id FROM document_rows AS tac_root WHERE ${scope.sql}`, { bind: scope.bind }),
    ).toEqual([{ id: 2 }]);
  });
});

import { Op, type Collection, type Database } from '@tego/server';

import type { AccessCollectionIdentity } from '../../access-control/config-store';
import { AccessRoleFilterCompiler } from '../../access-control/role-filter';
import { internalQuery } from '../../access-control/write-support';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const identity = (collectionName: string): AccessCollectionIdentity => ({
  collectionName,
  collectionKey: `${collectionName}-key`,
  dataSourceKey: 'main',
});

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('role authorization facts (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let projects: Collection;
  let links: Collection;
  let companies: Collection;
  let compiler: AccessRoleFilterCompiler;
  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
    for (const name of ['documents', 'projects', 'links', 'companies']) {
      db.collection({
        name,
        tableName: `role_filter_${name}`,
        timestamps: name === 'projects' || name === 'links',
        paranoid: name === 'projects' || name === 'links',
        fields: [
          { name: 'id', type: 'integer', primaryKey: true, field: 'record_id' },
          { name: 'name', type: 'string', field: 'display_name' },
          { name: 'amount', type: 'integer' },
          { name: 'enabled', type: 'boolean', defaultValue: true },
          { name: 'kind', type: 'string' },
          ...(name !== 'companies' ? [{ name: 'tenantId', type: 'string', field: 'tenant_id' }] : []),
          ...(name === 'documents' || name === 'links'
            ? [{ name: 'projectId', type: 'integer', field: 'project_id' }]
            : []),
          ...(name === 'projects' || name === 'links'
            ? [{ name: 'documentId', type: 'integer', field: 'document_id' }]
            : []),
          ...(name === 'projects' ? [{ name: 'companyId', type: 'integer', field: 'company_id' }] : []),
        ],
      });
    }
    docs = db.getCollection('documents');
    projects = db.getCollection('projects');
    links = db.getCollection('links');
    companies = db.getCollection('companies');
    docs.setField('project', { type: 'belongsTo', target: 'projects', foreignKey: 'projectId' });
    for (const [name, type] of [
      ['children', 'hasMany'],
      ['single', 'hasOne'],
    ])
      docs.setField(name, { type, target: 'projects', foreignKey: 'documentId', scope: { kind: 'matching' } });
    docs.setField('projects', {
      type: 'belongsToMany',
      target: 'projects',
      through: 'links',
      foreignKey: 'documentId',
      otherKey: 'projectId',
      throughUnique: false,
    });
    projects.setField('company', { type: 'belongsTo', target: 'companies', foreignKey: 'companyId' });
    companies.setField('projects', { type: 'hasMany', target: 'projects', foreignKey: 'companyId' });
    // Explicit association metadata is what Sequelize executes at runtime.
    (docs.model.associations.projects as unknown as { through: { scope: object } }).through.scope = {
      kind: 'matching',
    };
    projects.model.addScope('defaultScope', { where: { enabled: true } }, { override: true });
    links.model.addScope('defaultScope', { where: { enabled: true } }, { override: true });
    for (const collection of [docs, projects, links, companies]) await collection.model.sync();
    await companies.model.create({ id: 201, name: 'Customer' });
    await docs.model.bulkCreate([
      { id: 1, tenantId: 'H', name: 'First', amount: 10 },
      { id: 2, tenantId: 'H', name: 'Second', amount: 20 },
      { id: 3, tenantId: 'B', name: 'Inactive', amount: 30 },
      { id: 4, tenantId: 'C', name: 'Empty', amount: 40 },
      { id: 5, tenantId: null, name: 'Deleted', amount: 50 },
      { id: 6, tenantId: 'H', name: 'Last', amount: 60 },
    ]);
    await projects.model.bulkCreate([
      { id: 101, documentId: 1, companyId: 201, tenantId: 'B', name: 'Alpha', kind: 'matching' },
      { id: 102, documentId: 2, companyId: 201, tenantId: 'C', name: 'Secret', kind: 'matching' },
      { id: 103, documentId: 3, tenantId: 'C', name: 'Alpha', enabled: false, kind: 'matching' },
      { id: 104, documentId: 5, tenantId: 'C', name: 'Alpha', kind: 'matching' },
      { id: 105, documentId: 6, tenantId: 'C', name: 'Alpha', kind: 'other' },
      { id: 106, documentId: 1, tenantId: 'C', name: 'Extra', kind: 'matching' },
    ]);
    await projects.model.destroy({ where: { id: 104 } });
    for (const [id, projectId] of [
      [1, 101],
      [2, 102],
      [3, 103],
      [5, 104],
      [6, 105],
    ])
      await docs.model.update({ projectId }, { where: { id } });
    await links.model.bulkCreate([
      { id: 1, documentId: 1, projectId: 102, kind: 'matching' },
      { id: 2, documentId: 1, projectId: 102, kind: 'matching' },
      { id: 3, documentId: 2, projectId: 101, kind: 'other' },
      { id: 4, documentId: 3, projectId: 101, kind: 'matching', enabled: false },
      { id: 5, documentId: 5, projectId: 101, kind: 'matching' },
      { id: 6, documentId: 6, projectId: 104, kind: 'matching' },
    ]);
    await links.model.destroy({ where: { id: 5 } });
    compiler = new AccessRoleFilterCompiler(db, (collection) => identity(collection.name));
  });
  afterEach(async () => {
    try {
      if (dialect === 'postgres')
        await db.sequelize.query(
          'DROP TABLE IF EXISTS "role_filter_links", "role_filter_projects", "role_filter_companies", "role_filter_documents"',
        );
    } finally {
      await db.close();
    }
  });
  const plan = (filter: unknown) => compiler.compile(identity('documents'), filter);
  const rows = async (filter: unknown) => {
    const scoped = plan(filter);
    scoped.assertCurrent();
    const records = await docs.model.findAll(
      internalQuery({
        where: scoped.where,
        attributes: ['id'],
        order: [['id', 'ASC'] as [string, string]],
      }),
    );
    scoped.assertCurrent();
    return records.map((record) => record.getDataValue('id'));
  };
  it.each(['project', 'children', 'single'])(
    '%s checks internal facts without target tenant/read configuration',
    async (name) => {
      expect(await rows({ [name]: { name: 'Secret' } })).toEqual([2]);
    },
  );
  it('does not combine predicates matched by different related rows', async () => {
    expect(await rows({ children: { name: 'Alpha', tenantId: 'C' } })).toEqual([]);
    expect(await rows({ 'children.name': 'Alpha', 'children.tenantId': 'B' })).toEqual([1]);
  });
  it('preserves target defaults, deletion and association scope', async () => {
    expect(await rows({ project: { name: 'Alpha' } })).toEqual([1, 6]);
    expect(await rows({ children: { name: 'Alpha' } })).toEqual([1]);
    expect(await rows({ 'project.id.$notExists': true })).toEqual([3, 4, 5]);
  });
  it('preserves link defaults, deletion and scope without duplicating count or sums', async () => {
    const scoped = plan({ projects: { name: 'Secret' } });
    expect(await rows({ projects: { name: 'Secret' } })).toEqual([1]);
    expect(await rows({ projects: { name: 'Alpha' } })).toEqual([]);
    expect(await docs.model.count({ where: scoped.where })).toBe(1);
    expect(await docs.model.sum('amount', { where: scoped.where })).toBe(10);
  });
  it('supports paths revisiting a model and shared targets without tenant columns', async () => {
    expect(await rows({ 'project.company.projects.name': 'Secret' })).toEqual([1, 2]);
    expect(await rows({ project: { company: { name: 'Customer' } } })).toEqual([1, 2]);
  });
  it.each([
    [{ $or: [{}, { id: 1 }] }, [1, 2, 3, 4, 5, 6]],
    [{ $or: [{ $not: { $or: [{}, { id: 1 }] } }, { id: 2 }] }, [2]],
    [{ $or: [] }, []],
    [{ $and: [] }, [1, 2, 3, 4, 5, 6]],
    [{ $not: { project: { name: 'Secret' } } }, [1, 3, 4, 5, 6]],
    [{ $or: [{ tenantId: null }, { project: { name: 'Secret' } }] }, [2, 5]],
  ])('preserves logical and NULL semantics %#', async (filter, expected) => {
    expect(await rows(filter)).toEqual(expected);
  });
  it('snapshots filter values and escapes SQL-like text', async () => {
    const filter = { project: { name: "Secret' OR 1=1 --" } };
    const scoped = plan(filter);
    filter.project.name = 'Secret';
    expect(await docs.model.count({ where: scoped.where })).toBe(0);
  });
  it.each([
    { project: { missing: 1 } },
    { project: { name: { $regexp: '.*' } } },
    { project: { name: '{{ $user.id }}' } },
    { '{{unknown}}': 1 },
    { $and: [{ 'children.name': 'Alpha' }, { 'children.tenantId': 'C' }] },
    {
      project: {
        name: Object.defineProperty({}, '$eq', {
          get() {
            throw new Error('getter ran');
          },
          enumerable: true,
        }),
      },
    },
  ])('rejects unsupported or unresolved conditions %#', (filter) => {
    expect(() => plan(filter)).toThrow();
  });
  it('rejects mismatched, duplicate and cross-data-source identities', () => {
    expect(() => compiler.compile({ ...identity('documents'), collectionKey: 'recreated' }, {})).toThrow();
    compiler = new AccessRoleFilterCompiler(db, (collection) => ({
      ...identity(collection.name),
      dataSourceKey: collection === projects ? 'other' : 'main',
    }));
    expect(() => plan({ project: { name: 'Secret' } })).toThrow();
    compiler = new AccessRoleFilterCompiler(db, (collection) => ({
      ...identity(collection.name),
      collectionKey: 'same-key',
    }));
    expect(() => plan({ project: { name: 'Secret' } })).toThrow();
  });
  it.each(['target scope', 'relation scope', 'link scope', 'field', 'registry', 'stable identity'])(
    'rejects changed %s after compilation',
    (change) => {
      let revision = 'key';
      compiler = new AccessRoleFilterCompiler(db, (collection) => ({
        ...identity(collection.name),
        collectionKey: `${collection.name}-${revision}`,
      }));
      const scoped = plan({ projects: { name: 'Secret' } });
      if (change === 'target scope')
        projects.model.addScope('defaultScope', { where: { enabled: false } }, { override: true });
      if (change === 'relation scope')
        (docs.model.associations.projects as unknown as { scope: object }).scope = { name: 'Alpha' };
      if (change === 'link scope')
        links.model.addScope('defaultScope', { where: { enabled: false } }, { override: true });
      if (change === 'field') projects.model.rawAttributes.name.field = 'changed_name';
      if (change === 'registry') db.modelCollection.delete(projects.model);
      if (change === 'stable identity') revision = 'changed';
      expect(() => scoped.assertCurrent()).toThrow();
    },
  );
  it('rejects unsupported effective scopes rather than discarding them', () => {
    projects.model.addScope('defaultScope', { limit: 1 }, { override: true });
    expect(() => plan({ project: { name: 'Secret' } })).toThrow();
  });
  it('rejects a changed root SQL alias after compilation', () => {
    const scoped = plan({ project: { name: 'Secret' } });
    Object.defineProperty(docs.model, 'name', { value: 'renamed_alias', configurable: true });
    expect(() => scoped.assertCurrent()).toThrow();
  });
  it('uses registered non-primary target keys and physical foreign key columns', async () => {
    docs.setField('projectName', { type: 'string', field: 'project_name' });
    docs.setField('namedProject', {
      type: 'belongsTo',
      target: 'projects',
      foreignKey: 'projectName',
      targetKey: 'name',
      constraints: false,
    });
    await db.sequelize.query('ALTER TABLE "role_filter_documents" ADD COLUMN "project_name" VARCHAR(255)');
    await docs.model.update({ projectName: 'Secret' }, { where: { id: 1 } });
    await docs.model.update({ projectName: 'Alpha' }, { where: { id: 2 } });
    expect(await rows({ namedProject: { tenantId: 'C', name: 'Secret' } })).toEqual([1]);
  });
  it.each(['project', 'projects'])('avoids case-insensitive generated aliases for %s', async (name) => {
    const field = name === 'project' ? 'projectId' : 'id';
    const physical = docs.model.rawAttributes[field].field;
    await db.sequelize.query(`ALTER TABLE "role_filter_documents" RENAME COLUMN "${physical}" TO "target_key"`);
    docs.model.rawAttributes[field].field = 'target_key';
    (docs.model as typeof docs.model & { refreshAttributes(): void }).refreshAttributes();
    Object.defineProperty(docs.model, 'name', { value: 'TAC_ROLE_1', configurable: true });
    expect(await rows({ [name]: { name: 'Secret' } })).toEqual(name === 'project' ? [2] : [1]);
  });
  it('compiles synchronously without per-record database queries', async () => {
    const query = vi.spyOn(db.sequelize, 'query');
    const scoped = plan({ projects: { name: 'Secret' } });
    scoped.assertCurrent();
    expect(query).not.toHaveBeenCalled();
    await docs.model.findAll(internalQuery({ where: { [Op.and]: [scoped.where, { tenantId: 'H' }] } }));
    expect(query).toHaveBeenCalledTimes(1);
  });
});

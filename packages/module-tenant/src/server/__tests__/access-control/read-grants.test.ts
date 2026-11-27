import { ACL, type Collection, type Database } from '@tego/server';

import { accessCollectionKey } from '../../access-control/config-store';
import { AccessReadGrantAdapter } from '../../access-control/read-grants';
import { mainIdentity } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const projectIdentity = { ...mainIdentity, collectionKey: 'projects-key', collectionName: 'projects' };

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('entry read grants (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let projects: Collection;
  let adapter: AccessReadGrantAdapter;
  let acl: ACL;
  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
    for (const name of ['documents', 'projects']) {
      const collection = db.collection({
        name,
        tableName: `read_grants_${name}`,
        timestamps: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true, field: 'record_id' },
          { name: 'tenantId', type: 'string', field: 'tenant_id' },
          { name: 'name', type: 'string', field: 'display_name' },
          { name: 'amount', type: 'integer' },
          { name: 'createdById', type: 'integer', field: 'created_by' },
          { name: 'projectId', type: 'integer' },
          { name: 'labels', type: 'json' },
        ],
      });
      await collection.model.sync();
    }
    docs = db.getCollection('documents');
    projects = db.getCollection('projects');
    docs.setField('project', { type: 'belongsTo', target: 'projects', foreignKey: 'projectId' });
    await docs.model.bulkCreate([
      { id: 1, tenantId: 'B', name: 'Allowed', amount: 10, createdById: 28 },
      { id: 2, tenantId: 'H', name: 'Other', amount: 20, createdById: 16 },
      { id: 3, tenantId: 'B', name: 'Excluded', amount: 30, createdById: 28 },
    ]);
    adapter = new AccessReadGrantAdapter(db, (collection) =>
      accessCollectionKey(collection === docs ? mainIdentity : projectIdentity),
    );
    acl = new ACL();
    acl.setAvailableAction('view', { aliases: ['list', 'get'] });
    acl.define({ role: 'member' });
  });
  afterEach(async () => {
    try {
      if (dialect === 'postgres')
        await db.sequelize.query('DROP TABLE IF EXISTS "read_grants_documents", "read_grants_projects"');
    } finally {
      await db.close();
    }
  });
  const capture = (params: unknown) => adapter.capture(mainIdentity, { allowed: true, params });
  const ids = async (params: unknown) => {
    const grant = capture(params)!;
    const rows = await docs.model.findAll({ where: grant.where, attributes: ['id'], order: [['id', 'ASC']] });
    return rows.map((row) => row.getDataValue('id'));
  };
  it('preserves real role scopes, fixed predicates and resolved user variables', async () => {
    acl.getRole('member').grantAction('documents:view', {
      fields: ['id'],
      filter: { createdById: '{{ ctx.state.currentUser.id }}' },
    });
    acl.addFixedParams('documents', 'list', () => ({ filter: { name: { $ne: 'Excluded' } } }));
    const can = acl.can({ role: 'member', resource: 'documents', action: 'list' })!;
    const params = await acl.parseJsonTemplate(structuredClone(can.params), {
      db,
      state: { currentUser: { id: 28 }, currentRole: 'member' },
    } as unknown as Parameters<ACL['parseJsonTemplate']>[1]);
    expect(capture(params)!.fields).toEqual(['id']);
    expect(await ids(params)).toEqual([1]);
  });
  it('does not remove a finalized tenant scope by its text', async () => {
    expect(await ids({ filter: { tenantId: 'B' } })).toEqual([1, 3]);
  });
  it('supports root logical predicates independently of output field permissions', async () => {
    expect(
      await ids({
        fields: ['id'],
        filter: { $and: [{ $or: [{ createdById: 16 }, { amount: { $lt: 20 } }] }, { $not: { name: 'Excluded' } }] },
      }),
    ).toEqual([1, 2]);
    expect(await ids({ filter: { $or: [] } })).toEqual([]);
    expect(await ids({ filter: { $and: [] } })).toEqual([1, 2, 3]);
  });
  it('preserves truth values when negating empty logical groups', async () => {
    expect(await ids({ filter: { $not: {} } })).toEqual([]);
    expect(await ids({ filter: { $not: { $or: [] } } })).toEqual([1, 2, 3]);
    expect(await ids({ filter: { $not: { $and: [] } } })).toEqual([]);
  });
  it('preserves TRUE subgroups inside OR before negating the role condition', async () => {
    expect(await ids({ filter: { $not: { $or: [{}, { id: 1 }] } } })).toEqual([]);
    expect(await ids({ filter: { $not: { $or: [{ $and: [] }, { id: 1 }] } } })).toEqual([]);
    expect(await ids({ filter: { $not: { $and: [{ $or: [] }, { id: 1 }] } } })).toEqual([1, 2, 3]);
    expect(await ids({ filter: { $or: [{ $not: { $or: [] } }, { id: 1 }] } })).toEqual([1, 2, 3]);
  });
  it('preserves NULL comparison semantics in mixed logical conditions', async () => {
    await docs.model.create({ id: 4, name: null, createdById: null });
    expect(await ids({ filter: { $and: [{}, { $not: { name: 'Allowed' } }] } })).toEqual([2, 3]);
    expect(await ids({ filter: { $not: { $or: [{ $or: [] }, { name: 'Allowed' }] } } })).toEqual([2, 3]);
    expect(await ids({ filter: { $or: [{ $or: [] }, { $not: { name: 'Allowed' } }] } })).toEqual([2, 3]);
    expect(await ids({ filter: { $not: { $and: [{ $or: [] }, { name: 'Allowed' }] } } })).toEqual([1, 2, 3, 4]);
    expect(await ids({ filter: { $or: [{}, { name: 'Allowed' }] } })).toEqual([1, 2, 3, 4]);
    expect(await ids({ filter: { $not: { name: null } } })).toEqual([1, 2, 3]);
  });
  it('rejects permission field arrays with a custom prototype', () => {
    expect(() => capture({ fields: Object.setPrototypeOf(['id'], null) })).toThrow();
  });
  it('preserves unrestricted, empty and relation-only field grants', () => {
    expect(capture({})!.fields).toEqual([...Object.keys(docs.model.rawAttributes), 'project']);
    expect(capture({ fields: [] })!.fields).toEqual([]);
    expect(capture({ fields: [], appends: ['project'] })!.fields).toEqual(['project']);
    expect(capture({ appends: [] })!.fields).toEqual(Object.keys(docs.model.rawAttributes));
  });
  it('returns no grant for a denied operation despite apparent unrestricted params', () => {
    expect(adapter.capture(mainIdentity, { allowed: false, params: {} })).toBeNull();
  });
  it('keeps a snapshot of identities, fields and permission filters', async () => {
    const identity = { ...mainIdentity };
    const params = { fields: ['id'], appends: ['project'], filter: { createdById: 28 } };
    const grant = adapter.capture(identity, { allowed: true, params })!;
    identity.collectionKey = 'replaced';
    params.fields.push('name');
    params.appends.length = 0;
    params.filter.createdById = 16;
    expect(grant.identity).toEqual(mainIdentity);
    expect(grant.fields).toEqual(['id', 'project']);
    const rows = await docs.model.findAll({ where: grant.where, attributes: ['id'], order: [['id', 'ASC']] });
    expect(rows.map((row) => row.getDataValue('id'))).toEqual([1, 3]);
  });
  it('keeps independent grants for each real collection', () => {
    expect(adapter.capture(projectIdentity, { allowed: true, params: { fields: ['name'] } })!.identity).toEqual(
      projectIdentity,
    );
    expect(() =>
      adapter.capture({ ...mainIdentity, dataSourceKey: 'external' }, { allowed: true, params: {} }),
    ).toThrow();
    expect(() => adapter.capture({ ...mainIdentity, collectionKey: 'wrong' }, { allowed: true, params: {} })).toThrow();
    expect(() =>
      adapter.capture({ ...mainIdentity, collectionName: 'missing' }, { allowed: true, params: {} }),
    ).toThrow();
    expect(projects).toBe(db.getCollection('projects'));
  });
  it.each([
    { own: true },
    { whitelist: ['id'] },
    { blacklist: ['name'] },
    { limit: 1 },
    { where: {} },
    { filter: { project: { name: 'Secret' } } },
    { filter: { 'project.name': 'Secret' } },
    { filter: { 'project.$exists': true } },
    { filter: { labels: { $eq: {} } } },
    { filter: { createdAt: { $dateOn: '2026-10-15' } } },
    { filter: { name: { $unknown: 'ignored' } } },
    { filter: { name: { $ne: '{{ ctx.state.currentUser.name }}' } } },
    { filter: { name: '{{$user.name}}' } },
    { filter: { name: 'partial}}' } },
    { fields: ['missing'] },
    { fields: ['project.name'] },
    { fields: ['project'] },
    { fields: ['id', 'id'] },
    { appends: ['project.name'] },
    { appends: ['name'] },
    { appends: ['project', 'project'] },
    { fields: [undefined] },
    null,
    [],
  ])('rejects unsupported or unresolved permission params: %j', (params) => {
    expect(() => capture(params)).toThrow();
  });
  it('rejects accessors without executing them', () => {
    const getter = vi.fn(() => ['id']);
    expect(() => capture(Object.defineProperty({}, 'fields', { get: getter, enumerable: true }))).toThrow();
    const fields = ['id'];
    Object.defineProperty(fields, '0', { get: getter });
    expect(() => capture({ fields })).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it('rejects sparse permission field lists', () => {
    const fields: string[] = [];
    fields.length = 2;
    expect(() => capture({ fields })).toThrow();
  });
  it.each([{}, { allowed: 'true', params: {} }, { allowed: true }, { allowed: true, params: {}, filter: {} }])(
    'rejects an incomplete or ambiguous entry permission: %j',
    (permission) => {
      expect(() => adapter.capture(mainIdentity, permission as never)).toThrow();
    },
  );
});

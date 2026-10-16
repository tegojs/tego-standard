import { ACL, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { AccessBelongsToExpansionService } from '../../access-control/belongs-to-expansion';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { AccessEntryReadService } from '../../access-control/entry-reads';
import { AccessManyToManyExpansionService } from '../../access-control/many-to-many-expansion';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import type { AccessEntryReadPermission } from '../../access-control/read-grants';
import { AccessTargetForeignKeyExpansionService } from '../../access-control/target-foreign-key-expansion';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const identities = ['documents', 'projects', 'children', 'links'].map((name) =>
  name === 'documents' ? mainIdentity : { ...mainIdentity, collectionKey: `${name}-key`, collectionName: name },
);
const auth = { tenantId: 'B' };
const expansions = ['project', 'children', 'child', 'projects'].map((association) => ({
  association,
  attributes: ['name'],
}));

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('expanded entry reads (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let projects: Collection;
  let children: Collection;
  let links: Collection;
  let store: AccessConfigStore;
  let adapter: AccessAclScopeAdapter;
  let queries: AccessQueryService;
  let entry: AccessEntryReadService;
  let permissions: Map<string, AccessEntryReadPermission | null>;
  let resolver: ReturnType<typeof vi.fn>;
  let ctx: object;
  const identity = (collection: Collection) => identities.find((item) => item.collectionName === collection.name)!;
  const stableKey = (collection: Collection) => accessCollectionKey(identity(collection));
  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    for (const item of identities) {
      const name = item.collectionName;
      db.collection({
        name,
        tableName: `assembled_${name}`,
        timestamps: true,
        paranoid: true,
        defaultScope: { where: { enabled: true } },
        fields: [
          { name: 'id', type: 'integer', primaryKey: true, field: 'record_id' },
          { name: 'tenantId', type: 'string', field: 'tenant_id' },
          { name: 'name', type: 'string', field: 'display_name' },
          { name: 'amount', type: 'integer' },
          { name: 'enabled', type: 'boolean', defaultValue: true },
          { name: 'payload', type: 'json' },
          { name: 'deletedAt', type: 'date' },
          ...(['documents', 'links'].includes(name)
            ? [{ name: 'projectId', type: 'integer', field: 'project_id' }]
            : []),
          ...(['children', 'links'].includes(name)
            ? [{ name: 'documentId', type: 'integer', field: 'document_id' }]
            : []),
        ],
      });
      if (item !== mainIdentity)
        await db.getRepository('collections').create({ values: { key: item.collectionKey, name } });
    }
    docs = db.getCollection('documents');
    projects = db.getCollection('projects');
    children = db.getCollection('children');
    links = db.getCollection('links');
    docs.setField('project', { type: 'belongsTo', target: 'projects', foreignKey: 'projectId' });
    docs.setField('children', { type: 'hasMany', target: 'children', foreignKey: 'documentId' });
    docs.setField('child', { type: 'hasOne', target: 'children', foreignKey: 'documentId' });
    docs.setField('projects', {
      type: 'belongsToMany',
      target: 'projects',
      through: 'links',
      foreignKey: 'documentId',
      otherKey: 'projectId',
      throughUnique: false,
    });
    projects.setField('documents', { type: 'hasMany', target: 'documents', foreignKey: 'projectId' });
    children.setField('document', { type: 'belongsTo', target: 'documents', foreignKey: 'documentId' });
    for (const collection of [docs, projects, children, links]) await collection.model.sync();
    await docs.model.bulkCreate([
      { id: 1, tenantId: 'B', name: 'Owned', amount: 10, projectId: 101 },
      { id: 2, tenantId: 'H', name: 'Visible', amount: 20, projectId: 102 },
      { id: 3, tenantId: 'C', name: 'Hidden', amount: 30, projectId: 101 },
      { id: 4, tenantId: null, name: 'Legacy', amount: 40, projectId: 103 },
      { id: 5, tenantId: 'B', name: 'Empty', amount: 50 },
    ]);
    await projects.model.bulkCreate([
      { id: 101, tenantId: 'B', name: 'Zebra' },
      { id: 102, tenantId: 'C', name: 'Secret' },
      { id: 103, tenantId: 'B', name: 'Alpha' },
    ]);
    await children.model.bulkCreate([
      { id: 201, documentId: 1, tenantId: 'B', name: 'Child' },
      { id: 202, documentId: 1, tenantId: 'C', name: 'Secret' },
      { id: 203, documentId: 2, tenantId: 'H', name: 'Visible' },
      { id: 204, documentId: 4, tenantId: null, name: 'Legacy' },
    ]);
    await links.model.bulkCreate([
      { id: 301, documentId: 1, projectId: 101, tenantId: 'B', name: 'Owned' },
      { id: 302, documentId: 1, projectId: 101, tenantId: 'H', name: 'Visible' },
      { id: 303, documentId: 1, projectId: 102, tenantId: 'B', name: 'Owned' },
      { id: 304, documentId: 2, projectId: 101, tenantId: 'C', name: 'Hidden' },
      { id: 305, documentId: 4, projectId: 103, tenantId: null, name: 'Legacy' },
    ]);
    const tenants = db.collection({
      name: 'tenants',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'enabled', type: 'boolean' },
      ],
    });
    await tenants.model.sync();
    await tenants.model.bulkCreate(['H', 'B', 'C'].map((id) => ({ id, enabled: true })));
    store = new AccessConfigStore(db, (item) =>
      resolveModelMetadata(db.getCollection(item.collectionName), { resolveCollectionKey: stableKey }),
    );
    const config = configFor(ownerCondition);
    config.rules.push({
      ...configFor(
        {
          type: 'compare',
          operator: 'in',
          left: { type: 'field', path: 'name' },
          right: { type: 'literal', value: ['Visible', 'Legacy'] },
        },
        'visibility',
      ).rules[0],
      id: 'visible',
    });
    for (const item of identities) await store.save(item, { ...config, revision: 0 }, { userId: 28 });
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    queries = new AccessQueryService(db, adapter, stableKey);
    permissions = new Map();
    resolver = vi.fn((_collection: Collection, path: readonly string[]) =>
      permissions.has(path.join('.')) ? permissions.get(path.join('.'))! : { allowed: true, params: {} },
    );
    entry = new AccessEntryReadService(db, adapter, queries, identity, resolver);
    ctx = {};
    await adapter.prepare(ctx, identities);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      if (dialect === 'postgres')
        await db.sequelize.query(
          'DROP TABLE IF EXISTS "assembled_links", "assembled_children", "assembled_documents", "assembled_projects", "tenants", "rolesResourcesScopesActions", "dataSourcesRolesResourcesScopesActions", "rolesResourcesScopes", "dataSourcesRolesResourcesScopes", "access_config_collections", "access_config_dataSourcesCollections", "tenantAccessRevisions"',
        );
    } finally {
      await db.close();
    }
  });
  const list = (extra = {}) =>
    entry.listExpanded(ctx, mainIdentity, auth, { attributes: ['name'], expansions, ...extra });
  const get = (key: unknown, extra = {}) =>
    entry.getExpanded(ctx, mainIdentity, auth, { key, attributes: ['name'], expansions, ...extra });

  it('assembles all four relationships without exposing pairing keys or losing visible roots', async () => {
    expect(await list()).toEqual([
      {
        name: 'Owned',
        project: { name: 'Zebra' },
        children: [{ name: 'Child' }],
        child: { name: 'Child' },
        projects: [{ name: 'Zebra' }],
      },
      { name: 'Visible', project: null, children: [{ name: 'Visible' }], child: { name: 'Visible' }, projects: [] },
      {
        name: 'Legacy',
        project: { name: 'Alpha' },
        children: [{ name: 'Legacy' }],
        child: { name: 'Legacy' },
        projects: [{ name: 'Alpha' }],
      },
      { name: 'Empty', project: null, children: [], child: null, projects: [] },
    ]);
    expect(await get(2)).toEqual({
      name: 'Visible',
      project: null,
      children: [{ name: 'Visible' }],
      child: { name: 'Visible' },
      projects: [],
    });
    expect(await get(3)).toBeNull();
    expect(await get(999)).toBeNull();
  });
  it('supports relation-only output without granting or returning the source primary key', async () => {
    permissions.set('', { allowed: true, params: { fields: [], appends: ['project'] } });
    permissions.set('project', { allowed: true, params: { fields: ['name'] } });
    expect(await get(1, { attributes: [], expansions: [{ association: 'project', attributes: ['name'] }] })).toEqual({
      project: { name: 'Zebra' },
    });
    await expect(entry.get(ctx, mainIdentity, auth, { key: 1, attributes: [] })).rejects.toThrow();
  });
  it('keeps root sorting pagination filters and aggregates consistent', async () => {
    expect(await list({ sort: ['project.name'], limit: 2, offset: 1 })).toEqual([
      {
        name: 'Owned',
        project: { name: 'Zebra' },
        children: [{ name: 'Child' }],
        child: { name: 'Child' },
        projects: [{ name: 'Zebra' }],
      },
      { name: 'Visible', project: null, children: [{ name: 'Visible' }], child: { name: 'Visible' }, projects: [] },
    ]);
    const filter = { name: { $ne: 'Empty' } };
    expect(await list({ filter })).toHaveLength(3);
    expect(await entry.count(ctx, mainIdentity, auth, { filter })).toBe(3);
    expect(await entry.sum(ctx, mainIdentity, auth, { field: 'amount', filter })).toBe(70);
  });
  it.each(['source', 'association', 'target', 'field', 'through'])(
    'rejects missing %s authorization before any root SQL',
    async (side) => {
      if (side === 'source') permissions.set('', null);
      if (side === 'association') permissions.set('', { allowed: true, params: { fields: ['name'], appends: [] } });
      if (side === 'target') permissions.set('children', { allowed: false, params: {} });
      if (side === 'field') permissions.set('child', { allowed: true, params: { fields: [] } });
      if (side === 'through') permissions.set('projects.$through', null);
      const query = vi.spyOn(db.sequelize, 'query');
      await expect(list()).rejects.toThrow(/authorized/);
      expect(query).not.toHaveBeenCalled();
    },
  );
  it('preserves hidden authorization facts while filtering expanded rows independently', async () => {
    permissions.set('', {
      allowed: true,
      params: {
        fields: ['name'],
        appends: ['project', 'children', 'child', 'projects'],
        filter: { project: { name: 'Secret' } },
      },
    });
    permissions.set('projects.$through', { allowed: true, params: { fields: [], filter: { name: 'Owned' } } });
    expect(await list()).toEqual([
      { name: 'Visible', project: null, children: [{ name: 'Visible' }], child: { name: 'Visible' }, projects: [] },
    ]);
  });
  it('captures every sibling grant and reuses it for root filters sorting and expansion', async () => {
    const permission = { allowed: true, params: { fields: ['name'], filter: { name: 'Zebra' } } };
    permissions.set('project', permission);
    const fields = ['name'];
    const selected = [{ association: 'project', attributes: fields }];
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
      permission.params.fields.push('payload');
      permission.params.filter.name = 'Alpha';
      fields.push('payload');
      selected.push({ association: 'children', attributes: ['name'] });
      return original(...args);
    });
    expect(
      await list({ filter: { project: { name: 'Zebra' } }, sort: ['project.name'], expansions: selected }),
    ).toEqual([{ name: 'Owned', project: { name: 'Zebra' } }]);
    expect(resolver.mock.calls.map(([, path]) => path)).toEqual([[], ['project']]);
    expect(resolver.mock.calls.every(([, , operation]) => operation.kind === 'list')).toBe(true);
  });
  it.each(['association', 'target field', 'role fact'])(
    'rejects changed %s metadata after the root query',
    async (change) => {
      children.setField('document', { type: 'belongsTo', target: 'documents', foreignKey: 'documentId' });
      permissions.set('children', { allowed: true, params: { filter: { document: { name: 'Owned' } } } });
      const original = docs.model.findAll.bind(docs.model);
      vi.spyOn(docs.model, 'findAll').mockImplementationOnce(async (options) => {
        const result = await original(options);
        if (change === 'association')
          (docs.model.associations.children as unknown as { scope: object }).scope = { name: 'Changed' };
        if (change === 'target field') children.model.rawAttributes.name.field = 'payload';
        if (change === 'role fact')
          (children.model.associations.document as unknown as { scope: object }).scope = { name: 'Changed' };
        return result;
      });
      await expect(list()).rejects.toThrow(/changed/);
    },
  );
  it('rejects changes to a later sibling while an earlier target query is running', async () => {
    const original = projects.model.findAll.bind(projects.model);
    vi.spyOn(projects.model, 'findAll').mockImplementationOnce(async (options) => {
      const result = await original(options);
      children.model.rawAttributes.name.field = 'payload';
      return result;
    });
    await expect(list()).rejects.toThrow(/changed/);
  });
  it('uses one transaction for root values targets and through records', async () => {
    const transaction = await db.sequelize.transaction();
    try {
      await docs.model.update({ name: 'Changed' }, { where: { id: 1 }, transaction });
      await projects.model.update({ name: 'Changed target' }, { where: { id: 101 }, transaction });
      await links.model.update({ tenantId: 'C', name: 'Hidden' }, { where: { documentId: 1 }, transaction });
      expect(await get(1, { transaction })).toEqual({
        name: 'Changed',
        project: { name: 'Changed target' },
        children: [{ name: 'Child' }],
        child: { name: 'Child' },
        projects: [],
      });
    } finally {
      await transaction.rollback();
    }
    expect((await get(1))?.name).toBe('Owned');
    await expect(get(1, { transaction })).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
  });
  it('preserves complete authorized JSON without invoking custom getters', async () => {
    const payload = { items: Array.from({ length: 10050 }, (_, index) => index) };
    await docs.model.update({ payload }, { where: { id: 1 } });
    await projects.model.update({ payload }, { where: { id: 101 } });
    const getter = vi.fn(() => 'Secret');
    projects.model.rawAttributes.name.get = getter;
    (projects.model as unknown as { refreshAttributes(): void }).refreshAttributes();
    expect(
      await get(1, {
        attributes: ['payload'],
        expansions: [{ association: 'project', attributes: ['name', 'payload'] }],
      }),
    ).toEqual({ payload, project: { name: 'Zebra', payload } });
    expect(getter).not.toHaveBeenCalled();
  });
  it('does not claim visible historical root child or through records', async () => {
    await get(4);
    for (const [model, id] of [
      [docs.model, 4],
      [children.model, 204],
      [links.model, 305],
    ] as const)
      expect((await model.findByPk(id))!.getDataValue('tenantId')).toBeNull();
  });
  it('returns empty pages and rejects a missing tenant rather than assembling unrestricted associations', async () => {
    expect(await list({ filter: { name: 'Missing' } })).toEqual([]);
    await expect(entry.listExpanded(ctx, mainIdentity, {}, { attributes: ['name'], expansions })).rejects.toMatchObject(
      { code: 'MISSING_ACCESS_CONTEXT' },
    );
  });
  it('assembles explicitly shared collections without tenant columns or a tenant identity', async () => {
    for (const item of identities) {
      await store.save(
        item,
        { ...configFor({ type: 'constant', value: true }), ownership: { enabled: false }, revision: 1 },
        { userId: 28 },
      );
      await db.sequelize.getQueryInterface().removeColumn(`assembled_${item.collectionName}`, 'tenant_id');
      db.getCollection(item.collectionName).removeField('tenantId');
    }
    adapter.release(ctx);
    await adapter.prepare(ctx, identities);
    const query = vi.spyOn(db.sequelize, 'query');
    expect(
      await entry.getExpanded(
        ctx,
        mainIdentity,
        {},
        {
          key: 2,
          attributes: ['name'],
          expansions,
        },
      ),
    ).toEqual({
      name: 'Visible',
      project: { name: 'Secret' },
      children: [{ name: 'Visible' }],
      child: { name: 'Visible' },
      projects: [{ name: 'Zebra' }],
    });
    expect(query.mock.calls.map(([sql]) => String(sql)).join('\n')).not.toContain('tenant_id');
  });
  it.each(['root', 'target'])('withholds the entire response if the phase ends after a %s query', async (side) => {
    const model = side === 'root' ? docs.model : projects.model;
    const original = model.findAll.bind(model);
    vi.spyOn(model, 'findAll').mockImplementationOnce(async (options) => {
      const result = await original(options);
      adapter.release(ctx);
      return result;
    });
    await expect(list()).rejects.toThrow(/not prepared/);
  });
  it('keeps concurrent expanded operations separate for different identities', async () => {
    const [b, c] = await Promise.all([
      entry.getExpanded(ctx, mainIdentity, { tenantId: 'B' }, { key: 1, attributes: ['name'], expansions }),
      entry.getExpanded(ctx, mainIdentity, { tenantId: 'C' }, { key: 3, attributes: ['name'], expansions }),
    ]);
    expect(b).toMatchObject({ name: 'Owned', project: { name: 'Zebra' } });
    expect(c).toEqual({ name: 'Hidden', project: null, children: [], child: null, projects: [] });
  });
  it('preserves default scope and soft deletion for roots targets and links independently', async () => {
    await docs.model.update({ enabled: false }, { where: { id: 5 } });
    await projects.model.update({ deletedAt: new Date() }, { where: { id: 101 } });
    await children.model.update({ enabled: false }, { where: { id: 201 } });
    await links.model.update({ deletedAt: new Date() }, { where: { id: 305 } });
    expect(await list()).toEqual([
      { name: 'Owned', project: null, children: [], child: null, projects: [] },
      { name: 'Visible', project: null, children: [{ name: 'Visible' }], child: { name: 'Visible' }, projects: [] },
      {
        name: 'Legacy',
        project: { name: 'Alpha' },
        children: [{ name: 'Legacy' }],
        child: { name: 'Legacy' },
        projects: [],
      },
    ]);
  });
  it('keeps SQL queries constant for 20 and 100 roots with all four relations', async () => {
    const keys = Array.from({ length: 100 }, (_, index) => index + 1000);
    await docs.model.bulkCreate(keys.map((id) => ({ id, name: 'Bulk', tenantId: 'B', projectId: 101 })));
    await children.model.bulkCreate(
      keys.map((id) => ({ id: id + 1000, documentId: id, name: 'Child', tenantId: 'B' })),
    );
    await links.model.bulkCreate(keys.map((id) => ({ id: id + 2000, documentId: id, projectId: 101, tenantId: 'B' })));
    const query = vi.spyOn(db.sequelize, 'query');
    const filter = { name: 'Bulk' };
    expect(await list({ filter, limit: 20 })).toHaveLength(20);
    const count = query.mock.calls.length;
    query.mockClear();
    const result = await list({ filter, limit: 100 });
    expect(result).toHaveLength(100);
    expect(result.every((row) => row.project != null && Array.isArray(row.projects) && row.projects.length === 1)).toBe(
      true,
    );
    expect(query).toHaveBeenCalledTimes(count);
  });
  it.each([
    { where: {} },
    { include: ['project'] },
    { expansions: [] },
    { expansions: Array(1) },
    { expansions: [{ association: 'project.name', attributes: ['name'] }] },
    { expansions: [{ association: 'project', attributes: ['name'], where: {} }] },
    { expansions: [{ association: 'project', attributes: ['name', 'name'] }] },
    { expansions: [{ association: 'project', attributes: [] }] },
    { expansions: Array(21).fill({ association: 'project', attributes: ['name'] }) },
    {
      expansions: [
        { association: 'project', attributes: ['name'] },
        { association: 'project', attributes: ['payload'] },
      ],
    },
  ])('rejects malformed expanded reads %# before SQL', async (extra) => {
    const query = vi.spyOn(db.sequelize, 'query');
    await expect(list(extra)).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
  it('rejects request accessors without invoking them', async () => {
    const getter = vi.fn(() => expansions);
    const request = { attributes: ['name'], expansions };
    Object.defineProperty(request, 'expansions', { get: getter });
    await expect(entry.listExpanded(ctx, mainIdentity, auth, request)).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(['attributes', 'sort', 'filter'])('rejects custom %s array prototypes before copying', async (field) => {
    const values = field === 'filter' ? [{ name: 'Owned' }] : ['name'];
    Object.setPrototypeOf(values, Object.create(Array.prototype));
    const extra = field === 'filter' ? { filter: { $and: values } } : { [field]: values };
    const query = vi.spyOn(db.sequelize, 'query');
    await expect(list(extra)).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  describe('nested expansion', () => {
    const selected = [
      {
        association: 'project',
        attributes: [],
        expansions: [
          {
            association: 'documents',
            attributes: ['name'],
            expansions: [{ association: 'project', attributes: ['name'] }],
          },
        ],
      },
      {
        association: 'children',
        attributes: ['name'],
        expansions: [
          { association: 'document', attributes: [], expansions: [{ association: 'project', attributes: ['name'] }] },
        ],
      },
      { association: 'child', attributes: [], expansions: [{ association: 'document', attributes: ['name'] }] },
      {
        association: 'projects',
        attributes: [],
        expansions: [
          {
            association: 'documents',
            attributes: ['name'],
            expansions: [{ association: 'children', attributes: ['name'] }],
          },
        ],
      },
    ];
    const nested = (key: number, extra = {}) => get(key, { expansions: selected, ...extra });
    it('assembles three levels across all relationship types without exposing keys', async () => {
      expect(await nested(1)).toEqual({
        name: 'Owned',
        project: { documents: [{ name: 'Owned', project: { name: 'Zebra' } }] },
        children: [{ name: 'Child', document: { project: { name: 'Zebra' } } }],
        child: { document: { name: 'Owned' } },
        projects: [{ documents: [{ name: 'Owned', children: [{ name: 'Child' }] }] }],
      });
      expect(await nested(2)).toEqual({
        name: 'Visible',
        project: null,
        children: [{ name: 'Visible', document: { project: null } }],
        child: { document: { name: 'Visible' } },
        projects: [],
      });
    });
    it('authorizes fields at each full path and keeps the same target independent across branches', async () => {
      permissions.set('project', { allowed: true, params: { fields: [], appends: ['documents'] } });
      permissions.set('project.documents', { allowed: true, params: { fields: ['name'], appends: ['project'] } });
      permissions.set('project.documents.project', {
        allowed: true,
        params: { fields: ['name'], filter: { name: 'Missing' } },
      });
      expect((await nested(1))?.project).toEqual({ documents: [{ name: 'Owned', project: null }] });
      expect((await nested(1))?.children).toEqual([{ name: 'Child', document: { project: { name: 'Zebra' } } }]);
      expect(resolver.mock.calls.some(([, path]) => path.join('.') === 'projects.documents.children')).toBe(true);
    });
    it.each(['action', 'association', 'field', 'through'])(
      'rejects missing descendant %s permission before root SQL',
      async (side) => {
        let expansions: unknown = selected;
        if (side === 'action') permissions.set('children.document', null);
        if (side === 'association')
          permissions.set('children', { allowed: true, params: { fields: ['name'], appends: [] } });
        if (side === 'field') permissions.set('children.document.project', { allowed: true, params: { fields: [] } });
        if (side === 'through') {
          expansions = [
            {
              association: 'children',
              attributes: [],
              expansions: [
                {
                  association: 'document',
                  attributes: [],
                  expansions: [{ association: 'projects', attributes: ['name'] }],
                },
              ],
            },
          ];
          permissions.set('children.document.projects.$through', null);
        }
        const query = vi.spyOn(db.sequelize, 'query');
        await expect(nested(1, { expansions })).rejects.toThrow(/authorized/);
        expect(query).not.toHaveBeenCalled();
      },
    );
    it('captures nested permissions requests and metadata before the first root scope await', async () => {
      const permission = { allowed: true, params: { fields: ['name'], filter: { name: 'Zebra' } } };
      permissions.set('children.document.project', permission);
      const fields = ['name'];
      const descendants = [{ association: 'project', attributes: fields }];
      const expansions = [
        {
          association: 'children',
          attributes: [],
          expansions: [{ association: 'document', attributes: [], expansions: descendants }],
        },
      ];
      const original = queries.scopeQuery.bind(queries);
      vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
        permission.params.fields.push('payload');
        permission.params.filter.name = 'Alpha';
        fields.push('payload');
        descendants.length = 0;
        return original(...args);
      });
      expect(await nested(1, { expansions })).toEqual({
        name: 'Owned',
        children: [{ document: { project: { name: 'Zebra' } } }],
      });
      expect(resolver.mock.calls.filter(([, path]) => path.join('.') === 'children.document.project')).toHaveLength(1);
    });
    it('rejects changed deeper relationship metadata while the root query is in flight', async () => {
      const original = docs.model.findAll.bind(docs.model);
      vi.spyOn(docs.model, 'findAll').mockImplementationOnce(async (options) => {
        const rows = await original(options);
        (projects.model.associations.documents as unknown as { scope: object }).scope = { name: 'Changed' };
        return rows;
      });
      await expect(nested(1)).rejects.toThrow(/changed/);
    });
    it('uses the transaction for every descendant and preserves large JSON output', async () => {
      const payload = { items: Array.from({ length: 10050 }, (_, index) => index) };
      const transaction = await db.sequelize.transaction();
      try {
        await projects.model.update({ name: 'Changed', payload }, { where: { id: 101 }, transaction });
        expect(
          await nested(1, {
            transaction,
            expansions: [
              {
                association: 'children',
                attributes: ['name'],
                expansions: [
                  {
                    association: 'document',
                    attributes: [],
                    expansions: [{ association: 'project', attributes: ['name', 'payload'] }],
                  },
                ],
              },
            ],
          }),
        ).toEqual({
          name: 'Owned',
          children: [{ name: 'Child', document: { project: { name: 'Changed', payload } } }],
        });
      } finally {
        await transaction.rollback();
      }
    });
    it('accepts a bounded wide intermediate page and queries the descendant once', async () => {
      await children.model.bulkCreate(
        Array.from({ length: 1100 }, (_, index) => ({ id: 1000 + index, documentId: 1, name: 'Bulk', tenantId: 'B' })),
      );
      const result = await nested(1, {
        expansions: [
          { association: 'children', attributes: [], expansions: [{ association: 'document', attributes: ['name'] }] },
        ],
      });
      expect(result?.children).toHaveLength(1101);
      expect(
        (result!.children as Array<{ document: { name: string } }>).every((row) => row.document.name === 'Owned'),
      ).toBe(true);
      expect(resolver.mock.calls.filter(([, path]) => path.join('.') === 'children.document')).toHaveLength(1);
    });
    it('keeps query counts fixed for 20 and 100 roots sharing nested targets', async () => {
      await docs.model.bulkCreate(
        Array.from({ length: 100 }, (_, index) => ({ id: 1000 + index, name: 'Bulk', tenantId: 'B', projectId: 101 })),
      );
      const expansions = [
        { association: 'project', attributes: [], expansions: [{ association: 'documents', attributes: ['name'] }] },
      ];
      const query = vi.spyOn(db.sequelize, 'query');
      expect(await list({ filter: { name: 'Bulk' }, limit: 20, expansions })).toHaveLength(20);
      const count = query.mock.calls.length;
      query.mockClear();
      expect(await list({ filter: { name: 'Bulk' }, limit: 100, expansions })).toHaveLength(100);
      expect(query).toHaveBeenCalledTimes(count);
    });
    it('rejects excessive nested response fanout even when each query page is bounded', async () => {
      await docs.model.bulkCreate(
        Array.from({ length: 400 }, (_, index) => ({ id: 1000 + index, name: 'Bulk', tenantId: 'B', projectId: 101 })),
      );
      await expect(
        list({
          filter: { name: 'Bulk' },
          limit: 400,
          expansions: [
            {
              association: 'project',
              attributes: [],
              expansions: [{ association: 'documents', attributes: ['name'] }],
            },
          ],
        }),
      ).rejects.toThrow(/response.*limit/);
    });
    it.each([
      [{ association: 'project', attributes: [], expansions: [] }],
      [{ association: 'project', attributes: [], expansions: Array(1) }],
      [{ association: 'project', attributes: [], expansions: [{ association: 'documents', attributes: [] }] }],
      [
        {
          association: 'project',
          attributes: [],
          expansions: [
            {
              association: 'documents',
              attributes: [],
              expansions: [
                {
                  association: 'project',
                  attributes: [],
                  expansions: [{ association: 'documents', attributes: ['name'] }],
                },
              ],
            },
          ],
        },
      ],
    ])('rejects invalid nested shapes or excess depth %# before SQL', async (expansions) => {
      const query = vi.spyOn(db.sequelize, 'query');
      await expect(nested(1, { expansions })).rejects.toThrow();
      expect(query).not.toHaveBeenCalled();
    });
    it('rejects nested accessors without invoking them', async () => {
      const getter = vi.fn(() => selected);
      const expansion = { association: 'project', attributes: [] };
      Object.defineProperty(expansion, 'expansions', { get: getter });
      await expect(nested(1, { expansions: [expansion] })).rejects.toThrow();
      expect(getter).not.toHaveBeenCalled();
    });
    it('limits the total tree rather than granting 20 expansions to every level', async () => {
      const expansions = Array.from({ length: 20 }, (_, index) => ({
        association: `branch${index}`,
        attributes: ['name'],
        ...(index === 0 ? { expansions: [{ association: 'leaf', attributes: ['name'] }] } : {}),
      }));
      const query = vi.spyOn(db.sequelize, 'query');
      await expect(nested(1, { expansions })).rejects.toThrow(/20 association paths/);
      expect(query).not.toHaveBeenCalled();
    });
    it('reuses full path permissions between a nested request filter and expanded data', async () => {
      const result = await list({
        filter: { 'children.document.project.name': 'Zebra' },
        expansions: [
          {
            association: 'children',
            attributes: [],
            expansions: [
              {
                association: 'document',
                attributes: [],
                expansions: [{ association: 'project', attributes: ['name'] }],
              },
            ],
          },
        ],
      });
      expect(result).toEqual([{ name: 'Owned', children: [{ document: { project: { name: 'Zebra' } } }] }]);
      expect(resolver.mock.calls.filter(([, path]) => path.join('.') === 'children.document.project')).toHaveLength(1);
    });
    it('does not claim historical records while traversing back through readable associations', async () => {
      await nested(4);
      for (const [model, id] of [
        [docs.model, 4],
        [children.model, 204],
        [links.model, 305],
      ] as const)
        expect((await model.findByPk(id))!.getDataValue('tenantId')).toBeNull();
    });
    it('supports a fully shared nested path without any tenant columns or tenant context', async () => {
      for (const item of identities) {
        await store.save(
          item,
          { ...configFor({ type: 'constant', value: true }), ownership: { enabled: false }, revision: 1 },
          { userId: 28 },
        );
        await db.sequelize.getQueryInterface().removeColumn(`assembled_${item.collectionName}`, 'tenant_id');
        db.getCollection(item.collectionName).removeField('tenantId');
      }
      adapter.release(ctx);
      await adapter.prepare(ctx, identities);
      const query = vi.spyOn(db.sequelize, 'query');
      expect(
        await entry.getExpanded(
          ctx,
          mainIdentity,
          {},
          {
            key: 2,
            attributes: ['name'],
            expansions: [
              {
                association: 'children',
                attributes: [],
                expansions: [
                  {
                    association: 'document',
                    attributes: [],
                    expansions: [{ association: 'project', attributes: ['name'] }],
                  },
                ],
              },
            ],
          },
        ),
      ).toEqual({ name: 'Visible', children: [{ document: { project: { name: 'Secret' } } }] });
      expect(query.mock.calls.map(([sql]) => String(sql)).join('\n')).not.toContain('tenant_id');
    });
    it('withholds all assembled results if the phase ends at the deepest target query', async () => {
      const original = projects.model.findAll.bind(projects.model);
      vi.spyOn(projects.model, 'findAll').mockImplementationOnce(async (options) => {
        const rows = await original(options);
        adapter.release(ctx);
        return rows;
      });
      await expect(
        nested(1, {
          expansions: [
            {
              association: 'children',
              attributes: [],
              expansions: [
                {
                  association: 'document',
                  attributes: [],
                  expansions: [{ association: 'project', attributes: ['name'] }],
                },
              ],
            },
          ],
        }),
      ).rejects.toThrow(/not prepared/);
    });
    it.each(['belongsTo', 'targetForeignKey', 'manyToMany'])(
      'preserves non-enumerable server predicates in the %s pairing page',
      async (kind) => {
        const request = {
          association: kind === 'belongsTo' ? 'project' : kind === 'targetForeignKey' ? 'children' : 'projects',
          sourceKeys: [1],
          targetAttributes: ['name'],
        };
        Object.defineProperty(request, 'targetWhere', { value: { name: 'Missing' }, enumerable: false });
        const records =
          kind === 'belongsTo'
            ? await new AccessBelongsToExpansionService(db, adapter, queries).page(
                ctx,
                mainIdentity,
                identities[1],
                auth,
                request,
              )
            : kind === 'targetForeignKey'
              ? await new AccessTargetForeignKeyExpansionService(db, adapter, queries).page(
                  ctx,
                  mainIdentity,
                  identities[2],
                  auth,
                  request,
                )
              : await new AccessManyToManyExpansionService(db, adapter, queries).page(
                  ctx,
                  mainIdentity,
                  identities[1],
                  identities[3],
                  auth,
                  request,
                );
        expect(records.get('1')).toEqual(kind === 'belongsTo' ? null : []);
      },
    );
  });
});

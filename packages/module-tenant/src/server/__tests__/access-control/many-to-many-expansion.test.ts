import { ACL, literal, Op, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { AccessEntryReadService } from '../../access-control/entry-reads';
import { AccessManyToManyExpansionService } from '../../access-control/many-to-many-expansion';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import type { AccessEntryReadPermission } from '../../access-control/read-grants';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const target = { ...mainIdentity, collectionKey: 'projects-key', collectionName: 'projects' };
const through = { ...mainIdentity, collectionKey: 'links-key', collectionName: 'links' };
const identities = [mainIdentity, target, through];
const authenticated = { tenantId: 'B' };

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('many-to-many expansion (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let projects: Collection;
  let links: Collection;
  let store: AccessConfigStore;
  let adapter: AccessAclScopeAdapter;
  let queries: AccessQueryService;
  let expansion: AccessManyToManyExpansionService;
  let entry: AccessEntryReadService;
  let permissions: Map<string, AccessEntryReadPermission | null>;
  let permissionResolver: ReturnType<typeof vi.fn>;
  let ctx: object;
  const stableKey = (collection: Collection) =>
    accessCollectionKey({ ...mainIdentity, collectionKey: `${collection.name}-key`, collectionName: collection.name });
  const prepare = async () => {
    if (ctx) adapter.release(ctx);
    ctx = {};
    await adapter.prepare(ctx, identities);
  };

  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    for (const name of ['documents', 'projects', 'links']) {
      db.collection({
        name,
        tableName: `m2m_expand_${name}`,
        timestamps: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true, field: 'record_id' },
          { name: 'tenantId', type: 'string', field: 'tenant_id' },
          { name: 'name', type: 'string', field: 'display_name' },
          { name: 'secret', type: 'string' },
          { name: 'payload', type: 'json' },
          { name: 'deletedAt', type: 'date', field: 'deleted_at' },
          { name: 'enabled', type: 'boolean' },
          ...(name === 'links'
            ? [
                { name: 'documentId', type: 'integer', field: 'document_id' },
                { name: 'projectId', type: 'integer', field: 'project_id' },
              ]
            : []),
        ],
      });
    }
    docs = db.getCollection('documents');
    projects = db.getCollection('projects');
    links = db.getCollection('links');
    docs.setField('projects', {
      type: 'belongsToMany',
      target: 'projects',
      through: 'links',
      foreignKey: 'documentId',
      otherKey: 'projectId',
      throughUnique: false,
    });
    for (const collection of [docs, projects, links]) await collection.model.sync();
    await docs.model.bulkCreate([
      { id: 1, tenantId: 'B', name: 'Owned' },
      { id: 2, tenantId: 'H', name: 'Visible' },
      { id: 3, tenantId: 'C', name: 'Hidden' },
      { id: 4, tenantId: null, name: 'Legacy' },
      { id: 5, tenantId: 'B', name: 'Empty' },
    ]);
    await projects.model.bulkCreate([
      { id: 101, tenantId: 'B', name: 'Owned', secret: 'secret1', enabled: true },
      { id: 102, tenantId: 'H', name: 'Visible', secret: 'secret2', enabled: false },
      { id: 103, tenantId: 'C', name: 'Hidden' },
      { id: 104, tenantId: null, name: 'Legacy' },
      { id: 105, tenantId: 'B', name: 'Other' },
      { id: 106, tenantId: 'B', name: 'HiddenLink' },
      { id: 107, tenantId: 'B', name: 'Unlinked' },
    ]);
    await links.model.bulkCreate([
      { id: 1, documentId: 1, projectId: 101, tenantId: 'B', name: 'Owned' },
      { id: 2, documentId: 1, projectId: 101, tenantId: 'H', name: 'Visible' },
      { id: 3, documentId: 1, projectId: 102, tenantId: 'H', name: 'Visible' },
      { id: 4, documentId: 1, projectId: 103, tenantId: 'B', name: 'Owned' },
      { id: 5, documentId: 1, projectId: 104, tenantId: null, name: 'Legacy' },
      { id: 6, documentId: 2, projectId: 105, tenantId: 'B', name: 'Owned' },
      { id: 7, documentId: 3, projectId: 105, tenantId: 'B', name: 'Owned' },
      { id: 8, documentId: 4, projectId: 104, tenantId: null, name: 'Legacy' },
      { id: 9, documentId: 1, projectId: 106, tenantId: 'C', name: 'Hidden' },
      { id: 10, documentId: 2, projectId: 101, tenantId: 'B', name: 'Owned' },
    ]);
    const tenants = db.collection({
      name: 'tenants',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'parentId', type: 'string' },
        { name: 'enabled', type: 'boolean' },
      ],
    });
    await tenants.model.sync();
    await tenants.model.bulkCreate([
      { id: 'H', parentId: null, enabled: true },
      { id: 'B', parentId: 'H', enabled: true },
      { id: 'C', parentId: 'H', enabled: true },
    ]);
    for (const identity of [target, through])
      await db
        .getRepository('collections')
        .create({ values: { key: identity.collectionKey, name: identity.collectionName } });
    store = new AccessConfigStore(db, (identity) =>
      resolveModelMetadata(db.getCollection(identity.collectionName), { resolveCollectionKey: stableKey }),
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
    for (const identity of identities) await store.save(identity, { ...config, revision: 0 }, { userId: 28 });
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    queries = new AccessQueryService(db, adapter, stableKey);
    expansion = new AccessManyToManyExpansionService(db, adapter, queries);
    permissions = new Map();
    permissionResolver = vi.fn((_collection: Collection, path: readonly string[]) =>
      permissions.has(path.join('.')) ? permissions.get(path.join('.'))! : { allowed: true, params: {} },
    );
    entry = new AccessEntryReadService(
      db,
      adapter,
      queries,
      (collection) => ({ ...mainIdentity, collectionKey: `${collection.name}-key`, collectionName: collection.name }),
      permissionResolver,
    );
    await prepare();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      if (dialect === 'postgres')
        await db.sequelize.query(
          'DROP TABLE IF EXISTS "m2m_expand_links", "m2m_expand_projects", "m2m_expand_documents", "tenants", "rolesResourcesScopesActions", "dataSourcesRolesResourcesScopesActions", "rolesResourcesScopes", "dataSourcesRolesResourcesScopes", "access_config_collections", "access_config_dataSourcesCollections", "tenantAccessRevisions"',
        );
    } finally {
      await db.close();
    }
  });

  const load = (sourceKeys: Array<string | number> = [1, 2, 4, 5], extra = {}) =>
    expansion.load(ctx, mainIdentity, target, through, authenticated, {
      association: 'projects',
      sourceKeys,
      targetAttributes: ['id', 'name'],
      ...extra,
    });

  const entryLoad = (sourceKeys: Array<string | number> = [1, 2, 4, 5], extra = {}) =>
    entry.expandManyToMany(ctx, mainIdentity, authenticated, {
      association: 'projects',
      sourceKeys,
      targetAttributes: ['name'],
      ...extra,
    });

  it('entry intersects source target and through grants without exposing internal fields', async () => {
    permissions.set('', { allowed: true, params: { fields: [], appends: ['projects'] } });
    permissions.set('projects', { allowed: true, params: { fields: ['name'], filter: { name: { $ne: 'Owned' } } } });
    permissions.set('projects.$through', { allowed: true, params: { fields: [], filter: { name: 'Visible' } } });
    expect([...(await entryLoad())]).toEqual([
      ['1', [{ name: 'Visible' }]],
      ['2', []],
      ['4', []],
      ['5', []],
    ]);
    expect(permissionResolver.mock.calls.map(([, path]) => path)).toEqual([[], ['projects'], ['projects', '$through']]);
    expect(permissionResolver.mock.calls.every(([, , operation]) => operation.kind === 'expandManyToMany')).toBe(true);
  });
  it.each(['source', 'association', 'target', 'field', 'through'])(
    'entry denies missing %s permission before SQL',
    async (side) => {
      if (side === 'source') permissions.set('', null);
      if (side === 'association') permissions.set('', { allowed: true, params: { fields: ['id'], appends: [] } });
      if (side === 'target') permissions.set('projects', { allowed: false, params: {} });
      if (side === 'field') permissions.set('projects', { allowed: true, params: { fields: [] } });
      if (side === 'through') permissions.set('projects.$through', { allowed: false, params: {} });
      const query = vi.spyOn(db.sequelize, 'query');
      await expect(entryLoad()).rejects.toThrow(/authorized/);
      expect(query).not.toHaveBeenCalled();
    },
  );
  it('entry compiles role-only target and through facts without granting them payload access', async () => {
    links.setField('document', { type: 'belongsTo', target: 'documents', foreignKey: 'documentId' });
    projects.setField('links', { type: 'hasMany', target: 'links', foreignKey: 'projectId' });
    permissions.set('projects', { allowed: true, params: { fields: ['name'], filter: { links: { name: 'Hidden' } } } });
    permissions.set('projects.$through', {
      allowed: true,
      params: { fields: [], filter: { document: { name: 'Owned' } } },
    });
    // Project 106 has only a hidden link. It can match an internal role fact but cannot be expanded.
    expect([...(await entryLoad([1, 2]))]).toEqual([
      ['1', []],
      ['2', []],
    ]);
    expect(permissionResolver).toHaveBeenCalledTimes(3);
    permissions.set('projects', { allowed: true, params: { fields: ['name'], filter: { links: { name: 'Owned' } } } });
    expect([...(await entryLoad([1, 2]))]).toEqual([
      ['1', [{ name: 'Owned' }]],
      ['2', []],
    ]);
  });
  it('entry snapshots all three permissions and source request before the first await', async () => {
    const source = { allowed: true, params: { filter: { name: 'Owned' } } };
    const targetPermission = { allowed: true, params: { fields: ['name'], filter: { name: 'Owned' } } };
    const throughPermission = { allowed: true, params: { fields: [], filter: { name: 'Owned' } } };
    permissions.set('', source);
    permissions.set('projects', targetPermission);
    permissions.set('projects.$through', throughPermission);
    const keys = [1];
    const fields = ['name'];
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
      source.params.filter.name = 'Visible';
      targetPermission.params.filter.name = 'Visible';
      throughPermission.params.filter.name = 'Visible';
      keys[0] = 2;
      fields.push('secret');
      return original(...args);
    });
    expect([...(await entryLoad(keys, { targetAttributes: fields }))]).toEqual([['1', [{ name: 'Owned' }]]]);
    expect([...(await entryLoad([2]))]).toEqual([['2', []]]);
  });
  it('entry keeps overlapping tenant and through authorizations independent', async () => {
    let resume!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return original(...args);
    });
    permissionResolver.mockImplementation((_collection: Collection, path: readonly string[], operation) => ({
      allowed: true,
      params: path.includes('$through')
        ? { fields: [], filter: { name: operation.authenticated.tenantId === 'B' ? 'Owned' : 'Hidden' } }
        : path.length
          ? { fields: ['name'] }
          : {},
    }));
    const first = entryLoad([1]);
    try {
      await Promise.race([started, first]);
      expect([
        ...(await entry.expandManyToMany(
          ctx,
          mainIdentity,
          { tenantId: 'C' },
          {
            association: 'projects',
            sourceKeys: [3],
            targetAttributes: ['name'],
          },
        )),
      ]).toEqual([['3', []]]);
    } finally {
      resume();
    }
    expect([...(await first)]).toEqual([['1', [{ name: 'Owned' }]]]);
  });
  it.each(['source scope', 'source SQL', 'target scope', 'through scope', 'final SQL'])(
    'entry rechecks through role facts after %s',
    async (point) => {
      links.setField('document', { type: 'belongsTo', target: 'documents', foreignKey: 'documentId' });
      permissions.set('projects.$through', {
        allowed: true,
        params: { fields: [], filter: { document: { name: 'Owned' } } },
      });
      const change = () => {
        (links.model.associations.document as unknown as { scope: object }).scope = { name: 'Changed' };
      };
      if (point.endsWith('scope')) {
        const call = point === 'source scope' ? 1 : point === 'target scope' ? 2 : 3;
        let count = 0;
        const original = queries.scopeQuery.bind(queries);
        vi.spyOn(queries, 'scopeQuery').mockImplementation(async (...args) => {
          const result = await original(...args);
          if (++count === call) change();
          return result;
        });
      } else if (point === 'source SQL') {
        const original = docs.model.findAll.bind(docs.model);
        vi.spyOn(docs.model, 'findAll').mockImplementationOnce(async (options) => {
          const result = await original(options);
          change();
          return result;
        });
      } else {
        const original = db.sequelize.query.bind(db.sequelize);
        vi.spyOn(db.sequelize, 'query').mockImplementation(async (...args) => {
          const result = await original(...args);
          if (String(args[0]).includes('tac_expansion_target')) change();
          return result;
        });
      }
      await expect(entryLoad([1])).rejects.toThrow(/changed/);
    },
  );
  it('entry keeps SQL queries constant for 20 and 100 sources and deduplicates visible links', async () => {
    links.setField('document', { type: 'belongsTo', target: 'documents', foreignKey: 'documentId' });
    permissions.set('projects.$through', {
      allowed: true,
      params: { fields: [], filter: { document: { name: 'Owned' } } },
    });
    const keys = Array.from({ length: 100 }, (_, index) => index + 200);
    await docs.model.bulkCreate(keys.map((id) => ({ id, tenantId: 'B', name: 'Owned' })));
    await links.model.bulkCreate(
      keys.flatMap((id) => [
        { id: id + 1000, documentId: id, projectId: 101, tenantId: 'B' },
        { id: id + 2000, documentId: id, projectId: 101, tenantId: 'B' },
      ]),
    );
    const query = vi.spyOn(db.sequelize, 'query');
    expect((await entryLoad(keys.slice(0, 20))).size).toBe(20);
    const count = query.mock.calls.length;
    query.mockClear();
    const result = await entryLoad(keys);
    expect(result.size).toBe(100);
    expect([...result.values()]).toEqual(keys.map(() => [{ name: 'Owned' }]));
    expect(query).toHaveBeenCalledTimes(count);
  });
  it('entry returns large authorized JSON and retains native values', async () => {
    const payload = { items: Array.from({ length: 10050 }, (_, index) => index) };
    await projects.model.update({ payload }, { where: { id: 101 } });
    permissions.set('projects', { allowed: true, params: { fields: ['payload'], filter: { id: 101 } } });
    expect([...(await entryLoad([1], { targetAttributes: ['payload'] }))]).toEqual([['1', [{ payload }]]]);
    expect([...(await load([1], { targetAttributes: ['payload'], targetWhere: { id: 101 } }))]).toEqual([
      ['1', [{ payload }]],
    ]);
  });
  it.each([{ throughWhere: {} }, { through: target }, { association: 'projects.links' }, { sourceKeys: ['_'] }])(
    'entry rejects unsupported many-to-many input %# before SQL',
    async (extra) => {
      const query = vi.spyOn(db.sequelize, 'query');
      await expect(entryLoad([1], extra)).rejects.toThrow();
      expect(query).not.toHaveBeenCalled();
    },
  );

  it('batches readable targets and links without duplicates or losing empty roots', async () => {
    expect([...(await load())]).toEqual([
      [
        '1',
        [
          { id: 101, name: 'Owned' },
          { id: 102, name: 'Visible' },
          { id: 104, name: 'Legacy' },
        ],
      ],
      [
        '2',
        [
          { id: 101, name: 'Owned' },
          { id: 105, name: 'Other' },
        ],
      ],
      ['4', [{ id: 104, name: 'Legacy' }]],
      ['5', []],
    ]);
  });
  it('rejects any hidden or missing source', async () => {
    for (const keys of [
      [1, 3],
      [1, 999],
    ])
      await expect(load(keys)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
  });
  it('intersects all three independent ACL predicates', async () => {
    await expect(load([1, 2], { sourceWhere: { name: 'Owned' } })).rejects.toMatchObject({
      code: 'ACCESS_RECORD_UNAVAILABLE',
    });
    expect([
      ...(await load([1], { targetWhere: { id: { [Op.gte]: 102 } }, throughWhere: { name: 'Visible' } })),
    ]).toEqual([['1', [{ id: 102, name: 'Visible' }]]]);
    expect([...(await load([1], { targetWhere: { name: 'Hidden' } }))]).toEqual([['1', []]]);
  });
  it('deduplicates source keys preserves their order and returns only selected raw fields', async () => {
    expect([...(await load([2, '01', 2], { targetAttributes: ['name'] }))]).toEqual([
      ['2', [{ name: 'Owned' }, { name: 'Other' }]],
      ['1', [{ name: 'Owned' }, { name: 'Visible' }, { name: 'Legacy' }]],
    ]);
  });
  it('preserves boolean and date types without invoking getters', async () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    await projects.model.update({ deletedAt: date }, { where: { id: 101 } });
    const getter = vi.fn(() => 'secret');
    projects.model.rawAttributes.name.get = getter;
    (projects.model as unknown as { refreshAttributes(): void }).refreshAttributes();
    expect([
      ...(await load([1], { targetWhere: { id: 101 }, targetAttributes: ['name', 'enabled', 'deletedAt'] })),
    ]).toEqual([['1', [{ name: 'Owned', enabled: true, deletedAt: date }]]]);
    expect(getter).not.toHaveBeenCalled();
  });
  it('does not claim historical sources targets or links', async () => {
    await load([4]);
    expect([...(await entryLoad([4]))]).toEqual([['4', [{ name: 'Legacy' }]]]);
    for (const [model, id] of [
      [docs.model, 4],
      [projects.model, 104],
      [links.model, 8],
    ] as const)
      expect((await model.findByPk(id))!.getDataValue('tenantId')).toBeNull();
  });
  it('retains target and through association scopes', async () => {
    docs.setField('visibleProjects', {
      type: 'belongsToMany',
      target: 'projects',
      through: 'links',
      foreignKey: 'documentId',
      otherKey: 'projectId',
      throughUnique: false,
      scope: { name: 'Visible' },
      throughScope: { name: 'Visible' },
    });
    expect([...(await load([1, 2], { association: 'visibleProjects' }))]).toEqual([
      ['1', [{ id: 102, name: 'Visible' }]],
      ['2', []],
    ]);
    await links.model.update({ name: 'Owned', tenantId: 'B' }, { where: { id: 3 } });
    expect([...(await load([1], { association: 'visibleProjects' }))]).toEqual([['1', []]]);
  });
  it('retains all three default scopes', async () => {
    links.model.addScope('defaultScope', { where: { name: 'Owned' } }, { override: true });
    expect([...(await load([1]))]).toEqual([['1', [{ id: 101, name: 'Owned' }]]]);
    projects.model.addScope('defaultScope', { where: { name: 'Visible' } }, { override: true });
    expect([...(await load([1]))]).toEqual([['1', []]]);
    docs.model.addScope('defaultScope', { where: { name: 'Hidden' } }, { override: true });
    await expect(load([1])).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
  });
  it.each(['documents', 'projects', 'links'])('retains %s soft deletion', async (name) => {
    const model = db.getCollection(name).model;
    model.options.paranoid = true;
    (model as unknown as { _timestampAttributes: Record<string, string> })._timestampAttributes.deletedAt = 'deletedAt';
    await model.update(
      { deletedAt: new Date() },
      { where: { id: name === 'projects' ? 102 : name === 'links' ? 3 : 1 } },
    );
    if (name === 'documents') await expect(load([1])).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    else
      expect([...(await load([1]))]).toEqual([
        [
          '1',
          [
            { id: 101, name: 'Owned' },
            { id: 104, name: 'Legacy' },
          ],
        ],
      ]);
  });
  it('uses the active transaction for all three models', async () => {
    const transaction = await db.sequelize.transaction();
    try {
      await links.model.update({ documentId: 5 }, { where: { id: 6 }, transaction });
      expect([...(await load([2, 5], { transaction }))]).toEqual([
        ['2', [{ id: 101, name: 'Owned' }]],
        ['5', [{ id: 105, name: 'Other' }]],
      ]);
      expect([...(await entryLoad([2, 5], { transaction }))]).toEqual([
        ['2', [{ name: 'Owned' }]],
        ['5', [{ name: 'Other' }]],
      ]);
    } finally {
      await transaction.rollback();
    }
    expect([...(await load([5]))]).toEqual([['5', []]]);
  });
  it('rejects ended and foreign transactions', async () => {
    const ended = await db.sequelize.transaction();
    await ended.rollback();
    await expect(load([1], { transaction: ended })).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
    await expect(entryLoad([1], { transaction: ended })).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
    const other = sqliteDatabase();
    const foreign = await other.sequelize.transaction();
    try {
      await expect(load([1], { transaction: foreign })).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
    } finally {
      await foreign.rollback();
      await other.close();
    }
  });
  it('snapshots identities keys fields and predicates before the first await', async () => {
    const keys = [2];
    const fields = ['name'];
    const where = { name: 'Owned' };
    const auth = { tenantId: 'B' };
    const source = { ...mainIdentity };
    const to = { ...target };
    const join = { ...through };
    const pending = expansion.load(ctx, source, to, join, auth, {
      association: 'projects',
      sourceKeys: keys,
      targetAttributes: fields,
      targetWhere: where,
    });
    keys[0] = 3;
    fields.push('secret');
    where.name = 'Hidden';
    auth.tenantId = 'C';
    source.collectionKey = 'wrong';
    to.collectionKey = 'wrong';
    join.collectionKey = 'wrong';
    expect([...(await pending)]).toEqual([['2', [{ name: 'Owned' }]]]);
  });
  it('uses separate source bindings and rejects target-through binding collisions', async () => {
    expect([
      ...(await load([1], {
        sourceWhere: literal('"documents"."display_name" = $name'),
        sourceBind: { name: 'Owned' },
        targetWhere: literal('"projects"."display_name" = $name'),
        targetBind: { name: 'Visible' },
        throughWhere: literal('"links"."display_name" = $link'),
        throughBind: { link: 'Visible' },
      })),
    ]).toEqual([['1', [{ id: 102, name: 'Visible' }]]]);
    await expect(load([1], { targetBind: { value: 1 }, throughBind: { value: 2 } })).rejects.toMatchObject({
      code: 'INVALID_ACCESS_MUTATION',
    });
  });
  it.each(identities)('fails closed for empty $collectionName rules', async (identity) => {
    await store.save(identity, { ...(await store.read(identity)), rules: [] }, { userId: 28 });
    await prepare();
    if (identity === mainIdentity) await expect(load([1])).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    else expect([...(await load([1]))]).toEqual([['1', []]]);
  });
  it('requires prepared migrated through configuration', async () => {
    await db.getCollection('collections').model.update({ options: {} }, { where: { key: through.collectionKey } });
    await prepare();
    await expect(load([1])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });
  it('supports shared target and through tables without tenant columns', async () => {
    for (const [identity, collection] of [
      [target, projects],
      [through, links],
    ] as const) {
      await store.save(
        identity,
        { ...configFor({ type: 'constant', value: true }), ownership: { enabled: false }, revision: 1 },
        { userId: 28 },
      );
      collection.removeField('tenantId');
      await db.sequelize.getQueryInterface().removeColumn(collection.model.getTableName(), 'tenant_id');
    }
    await prepare();
    expect((await load([1])).get('1')).toHaveLength(5);
    expect((await entryLoad([1])).get('1')).toHaveLength(5);
    permissions.set('projects', { allowed: true, params: { fields: ['name'], filter: { name: 'Visible' } } });
    permissions.set('projects.$through', { allowed: true, params: { fields: [], filter: { name: 'Visible' } } });
    expect([...(await entryLoad([1]))]).toEqual([['1', [{ name: 'Visible' }]]]);
    expect([...(await load([1], { throughWhere: { name: 'Visible' }, targetWhere: { name: 'Visible' } }))]).toEqual([
      ['1', [{ id: 102, name: 'Visible' }]],
    ]);
  });
  it('keeps SQL count constant for 20 and 100 roots', async () => {
    await docs.model.bulkCreate(Array.from({ length: 100 }, (_, i) => ({ id: 200 + i, tenantId: 'B', name: 'Owned' })));
    await links.model.bulkCreate(
      Array.from({ length: 100 }, (_, i) => ({ id: 200 + i, documentId: 200 + i, projectId: 101, tenantId: 'B' })),
    );
    const messages: string[] = [];
    const runtime = db.sequelize as unknown as { options: { logging: false | ((sql: string) => void) } };
    const logging = runtime.options.logging;
    runtime.options.logging = (sql) => messages.push(sql);
    try {
      expect((await load(Array.from({ length: 20 }, (_, i) => 200 + i))).size).toBe(20);
      const count = messages.length;
      messages.length = 0;
      expect((await load(Array.from({ length: 100 }, (_, i) => 200 + i))).size).toBe(100);
      expect(messages).toHaveLength(count);
      expect(count).toBeLessThanOrEqual(5);
    } finally {
      runtime.options.logging = logging;
    }
  });
  it('deduplicates in SQL before applying the expansion cap', async () => {
    await links.model.bulkCreate(
      Array.from({ length: 10001 }, (_, i) => ({ id: 1000 + i, documentId: 5, projectId: 101, tenantId: 'B' })),
    );
    expect([...(await load([5]))]).toEqual([['5', [{ id: 101, name: 'Owned' }]]]);
  });
  it('rejects more than 10000 visible source-target pairs', async () => {
    await projects.model.bulkCreate(
      Array.from({ length: 10001 }, (_, i) => ({ id: 1000 + i, tenantId: 'B', name: 'Owned' })),
    );
    await links.model.bulkCreate(
      Array.from({ length: 10001 }, (_, i) => ({ id: 1000 + i, documentId: 5, projectId: 1000 + i, tenantId: 'B' })),
    );
    await expect(load([5])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });
  it('validates empty pages and rejects missing tenant context', async () => {
    expect((await load([])).size).toBe(0);
    await expect(
      expansion.load(
        ctx,
        mainIdentity,
        target,
        through,
        {},
        {
          association: 'projects',
          sourceKeys: [],
          targetAttributes: ['name'],
        },
      ),
    ).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
  });
  it.each([
    { sourceKeys: ['_'] },
    { sourceKeys: [1.5] },
    { sourceKeys: Array(1) },
    { sourceKeys: Array(1001).fill(1) },
    { targetAttributes: [] },
    { targetAttributes: Array(1) },
    { targetAttributes: ['missing'] },
    { targetAttributes: [['name', 'alias']] },
    { targetAttributes: [literal('1')] },
    { sourceBind: [1] },
    { targetBind: [1] },
    { throughBind: [1] },
    { association: 'missing' },
    { association: null },
    { association: 'toString' },
    { limit: 1 },
    { include: ['projects'] },
    { order: [['id', 'DESC']] },
    { throughAttributes: ['secret'] },
  ])('rejects unsupported input %#', async (extra) => {
    await expect(load([1], extra)).rejects.toThrow();
  });
  it('rejects nested input accessors without invoking them', async () => {
    const getter = vi.fn(() => 'secret');
    await expect(
      load([1], { throughWhere: Object.defineProperty({}, 'name', { enumerable: true, get: getter }) }),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects virtual fields and keeps JSON projections outside SQL deduplication', async () => {
    projects.setField('derived', { type: 'virtual', get: () => 'secret' });
    await expect(load([1], { targetAttributes: ['derived'] })).rejects.toMatchObject({
      code: 'INVALID_ACCESS_MUTATION',
    });
    projects.setField('details', { type: 'json' });
    await projects.model.sync({ alter: true });
    await projects.model.update({ details: { label: 'ok' } }, { where: { id: 101 } });
    expect([...(await load([1], { targetWhere: { id: 101 }, targetAttributes: ['details'] }))]).toEqual([
      ['1', [{ details: { label: 'ok' } }]],
    ]);
  });

  it('does not confuse internal source keys with identically named target fields', async () => {
    projects.setField('tac_expansion_source', { type: 'string' });
    await projects.model.sync({ alter: true });
    await projects.model.update({ tac_expansion_source: 'target field' }, { where: { id: 101 } });
    expect([...(await load([1], { targetWhere: { id: 101 }, targetAttributes: ['tac_expansion_source'] }))]).toEqual([
      ['1', [{ tac_expansion_source: 'target field' }]],
    ]);
  });

  it('preserves independent relational target and through visibility', async () => {
    links.setField('document', { type: 'belongsTo', target: 'documents', foreignKey: 'documentId' });
    projects.setField('links', { type: 'hasMany', target: 'links', foreignKey: 'projectId' });
    await store.save(
      through,
      {
        ...configFor(
          {
            type: 'exists',
            path: 'document',
            condition: {
              type: 'compare',
              operator: 'eq',
              left: { type: 'field', path: 'name' },
              right: { type: 'literal', value: 'Visible' },
            },
          },
          'visibility',
        ),
        revision: 1,
      },
      { userId: 28 },
    );
    await store.save(
      target,
      {
        ...configFor(
          {
            type: 'exists',
            path: 'links.document',
            condition: {
              type: 'compare',
              operator: 'eq',
              left: { type: 'field', path: 'name' },
              right: { type: 'literal', value: 'Visible' },
            },
          },
          'visibility',
        ),
        revision: 1,
      },
      { userId: 28 },
    );
    await prepare();
    expect([...(await load([1, 2]))]).toEqual([
      ['1', []],
      [
        '2',
        [
          { id: 101, name: 'Owned' },
          { id: 105, name: 'Other' },
        ],
      ],
    ]);
  });

  it.each(identities)('rejects changed $collectionName metadata after SQL', async (identity) => {
    if (identity === mainIdentity) {
      const original = docs.model.findAll.bind(docs.model);
      vi.spyOn(docs.model, 'findAll').mockImplementationOnce(async (options) => {
        const records = await original(options);
        docs.model.rawAttributes.name.field = 'secret';
        return records;
      });
    } else {
      const original = db.sequelize.query.bind(db.sequelize);
      vi.spyOn(db.sequelize, 'query').mockImplementation(async (...args) => {
        const result = await original(...args);
        if ((args[1] as { model?: unknown })?.model === projects.model)
          db.getCollection(identity.collectionName).model.rawAttributes.name.field = 'secret';
        return result;
      });
    }
    await expect(load([1])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });

  it.each(['association', 'throughScope', 'targetScope', 'defaultScope', 'phase'])(
    'rejects %s changes during async authorization',
    async (kind) => {
      const original = queries.scopeQuery.bind(queries);
      vi.spyOn(queries, 'scopeQuery').mockImplementation(async (...args) => {
        const result = await original(...args);
        if (args[1].collectionName === through.collectionName) {
          const association = docs.model.associations.projects as unknown as {
            scope: object;
            through: { scope: object };
          };
          if (kind === 'association') delete docs.model.associations.projects;
          if (kind === 'throughScope') association.through.scope = { name: 'Hidden' };
          if (kind === 'targetScope') association.scope = { name: 'Hidden' };
          if (kind === 'defaultScope')
            projects.model.addScope('defaultScope', { where: { name: 'Hidden' } }, { override: true });
          if (kind === 'phase') adapter.release(ctx);
        }
        return result;
      });
      await expect(load([1])).rejects.toMatchObject({
        code: kind === 'phase' ? 'INVALID_ACCESS_CONFIG_WRITE' : 'INVALID_ACCESS_MUTATION',
      });
    },
  );

  it('rejects a configuration replaced during target authorization', async () => {
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[1].collectionName === target.collectionName) {
        await store.save(target, { ...(await store.read(target)), rules: [] }, { userId: 28 });
        await prepare();
      }
      return result;
    });
    // The service captured the original phase object; replacing the caller's ctx cannot revive it.
    await expect(load([1])).rejects.toMatchObject({ code: 'INVALID_ACCESS_CONFIG_WRITE' });
  });

  it('rejects a late result when the phase ends after the joined query', async () => {
    const original = db.sequelize.query.bind(db.sequelize);
    vi.spyOn(db.sequelize, 'query').mockImplementation(async (...args) => {
      const result = await original(...args);
      if ((args[1] as { model?: unknown })?.model === projects.model) adapter.release(ctx);
      return result;
    });
    await expect(load([1])).rejects.toMatchObject({ code: 'INVALID_ACCESS_CONFIG_WRITE' });
  });

  it('rejects cross-source wrong and unprepared identities', async () => {
    for (const identity of [{ ...through, collectionKey: 'wrong' }, { ...through, dataSourceKey: 'other' }, target])
      await expect(
        expansion.load(ctx, mainIdentity, target, identity, authenticated, {
          association: 'projects',
          sourceKeys: [1],
          targetAttributes: ['name'],
        }),
      ).rejects.toThrow();
    const other = {};
    await adapter.prepare(other, [mainIdentity, target]);
    await expect(
      expansion.load(other, mainIdentity, target, through, authenticated, {
        association: 'projects',
        sourceKeys: [1],
        targetAttributes: ['name'],
      }),
    ).rejects.toThrow();
  });

  it('rejects an association that bypasses through soft deletion', async () => {
    links.model.options.paranoid = true;
    (links.model as unknown as { _timestampAttributes: Record<string, string> })._timestampAttributes.deletedAt =
      'deletedAt';
    docs.setField('deletedProjects', {
      type: 'belongsToMany',
      target: 'projects',
      through: 'links',
      foreignKey: 'documentId',
      otherKey: 'projectId',
      throughUnique: false,
      throughParanoid: false,
    });
    await expect(load([1], { association: 'deletedProjects' })).rejects.toMatchObject({
      code: 'INVALID_ACCESS_MUTATION',
    });
  });

  it('reads actual string keys and rejects the protocol placeholder even if that record exists', async () => {
    const source = { ...mainIdentity, collectionKey: 'stringSources-key', collectionName: 'stringSources' };
    const join = { ...mainIdentity, collectionKey: 'stringLinks-key', collectionName: 'stringLinks' };
    const stringDocs = db.collection({
      name: 'stringSources',
      tableName: 'm2m_expand_string_sources',
      timestamps: false,
      autoGenId: false,
      fields: [{ name: 'id', type: 'string', primaryKey: true }],
    });
    const stringLinks = db.collection({
      name: 'stringLinks',
      tableName: 'm2m_expand_string_links',
      timestamps: false,
      fields: [
        { name: 'sourceId', type: 'string' },
        { name: 'projectId', type: 'integer' },
      ],
    });
    stringDocs.setField('projects', {
      type: 'belongsToMany',
      target: 'projects',
      through: 'stringLinks',
      foreignKey: 'sourceId',
      otherKey: 'projectId',
      throughUnique: false,
    });
    try {
      await stringDocs.model.sync();
      await stringLinks.model.sync();
      await stringDocs.model.bulkCreate([{ id: 'actual' }, { id: '_' }]);
      await stringLinks.model.bulkCreate([
        { sourceId: 'actual', projectId: 101 },
        { sourceId: '_', projectId: 101 },
      ]);
      for (const identity of [source, join]) {
        await db
          .getRepository('collections')
          .create({ values: { key: identity.collectionKey, name: identity.collectionName } });
        await store.save(
          identity,
          { ...configFor({ type: 'constant', value: true }), ownership: { enabled: false }, revision: 0 },
          { userId: 28 },
        );
      }
      const stringCtx = {};
      await adapter.prepare(stringCtx, [source, target, join]);
      const request = { association: 'projects', sourceKeys: ['actual'], targetAttributes: ['name'] };
      expect([...(await expansion.load(stringCtx, source, target, join, authenticated, request))]).toEqual([
        ['actual', [{ name: 'Owned' }]],
      ]);
      await expect(
        expansion.load(stringCtx, source, target, join, authenticated, { ...request, sourceKeys: ['_'] }),
      ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    } finally {
      await stringLinks.model.drop();
      await stringDocs.model.drop();
    }
  });
});

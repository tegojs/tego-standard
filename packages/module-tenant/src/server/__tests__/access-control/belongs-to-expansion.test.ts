import { ACL, literal, Op, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { AccessBelongsToExpansionService } from '../../access-control/belongs-to-expansion';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { AccessEntryReadService } from '../../access-control/entry-reads';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import type { AccessEntryReadPermission } from '../../access-control/read-grants';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const target = { ...mainIdentity, collectionName: 'projects', collectionKey: 'projects-key' };
const authenticated = { tenantId: 'B' };

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('belongs-to expansion (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let projects: Collection;
  let store: AccessConfigStore;
  let adapter: AccessAclScopeAdapter;
  let queries: AccessQueryService;
  let expansion: AccessBelongsToExpansionService;
  let entry: AccessEntryReadService;
  let permissions: Map<string, AccessEntryReadPermission | null>;
  let permissionResolver: ReturnType<typeof vi.fn>;
  let ctx: object;
  const stableKey = (collection: Collection) =>
    accessCollectionKey({ ...mainIdentity, collectionKey: `${collection.name}-key`, collectionName: collection.name });

  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    for (const name of ['documents', 'projects']) {
      const collection = db.collection({
        name,
        tableName: `expand_${name}`,
        timestamps: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true, field: 'record_id' },
          { name: 'tenantId', type: 'string', field: 'tenant_id' },
          { name: 'name', type: 'string' },
          { name: 'secret', type: 'string' },
          { name: 'payload', type: 'json' },
          { name: 'deletedAt', type: 'date', field: 'deleted_at' },
          ...(name === 'documents' ? [{ name: 'projectId', type: 'integer', field: 'project_id' }] : []),
        ],
      });
      await collection.model.sync();
    }
    docs = db.getCollection('documents');
    projects = db.getCollection('projects');
    docs.setField('project', { type: 'belongsTo', target: 'projects', foreignKey: 'projectId' });
    await projects.repository.create({
      values: [
        { id: 101, tenantId: 'B', name: 'Owned', secret: 'Private owned' },
        { id: 102, tenantId: 'H', name: 'Visible', secret: 'Private visible' },
        { id: 103, tenantId: 'C', name: 'Hidden', secret: 'Private hidden' },
        { id: 104, tenantId: null, name: 'Legacy', secret: 'Private legacy' },
      ],
    });
    await docs.repository.create({
      values: [
        ...[101, 102, 103, 104, null, 999].map((projectId, i) => ({
          id: i + 1,
          tenantId: 'B',
          name: 'Owned',
          projectId,
        })),
        { id: 7, tenantId: 'C', name: 'Hidden', projectId: 101 },
        { id: 8, tenantId: 'H', name: 'Visible', projectId: 101 },
        { id: 9, tenantId: null, name: 'Legacy', projectId: 104 },
        { id: 10, tenantId: 'B', name: 'Owned', projectId: 101 },
      ],
    });
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
    await tenants.repository.create({
      values: [
        { id: 'H', enabled: true },
        { id: 'B', parentId: 'H', enabled: true },
        { id: 'C', parentId: 'H', enabled: true },
      ],
    });
    await db
      .getRepository('collections')
      .create({ values: { key: target.collectionKey, name: target.collectionName } });
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
    for (const identity of [mainIdentity, target])
      await store.save(identity, { ...config, revision: 0 }, { userId: 28 });
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    queries = new AccessQueryService(db, adapter, stableKey);
    expansion = new AccessBelongsToExpansionService(db, adapter, queries);
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
    ctx = {};
    await adapter.prepare(ctx, [mainIdentity, target]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      if (dialect === 'postgres')
        await db.sequelize.query(
          'DROP TABLE IF EXISTS "expand_documents", "expand_projects", "expand_users", "tenants", "rolesResourcesScopesActions", "dataSourcesRolesResourcesScopesActions", "rolesResourcesScopes", "dataSourcesRolesResourcesScopes", "access_config_collections", "access_config_dataSourcesCollections", "tenantAccessRevisions"',
        );
    } finally {
      await db.close();
    }
  });

  const load = (sourceKeys: Array<string | number> = [1, 2, 3, 4, 5, 6], extra = {}) =>
    expansion.load(ctx, mainIdentity, target, authenticated, {
      association: 'project',
      sourceKeys,
      targetAttributes: ['name'],
      ...extra,
    });

  const entryLoad = async (sourceKeys: Array<string | number> = [1, 2, 3, 4, 5, 6], extra = {}) =>
    entry.expandBelongsTo(ctx, mainIdentity, authenticated, {
      association: 'project',
      sourceKeys,
      targetAttributes: ['name'],
      ...extra,
    });

  it('entry expands only independently readable targets without dropping source records', async () => {
    permissions.set('', { allowed: true, params: { fields: [], appends: ['project'] } });
    permissions.set('project', { allowed: true, params: { fields: ['name'], appends: [] } });
    expect([...(await entryLoad())]).toEqual([
      ['1', { name: 'Owned' }],
      ['2', { name: 'Visible' }],
      ['3', null],
      ['4', { name: 'Legacy' }],
      ['5', null],
      ['6', null],
    ]);
    expect(permissionResolver.mock.calls.map(([, path]) => path)).toEqual([[], ['project']]);
  });
  it('entry preserves real finalized ACL fields and source role conditions', async () => {
    const acl = new ACL();
    acl.setAvailableAction('view', { aliases: ['get', 'list'] });
    acl.define({ role: 'reader' }).grantAction('documents:view', {
      fields: [],
      appends: ['project'],
      filter: { project: { name: '{{ ctx.state.currentUser.projectName }}' } },
    });
    const permission = acl.can({ role: 'reader', resource: 'documents', action: 'list' })!;
    const params = await acl.parseJsonTemplate(structuredClone(permission.params), {
      db,
      state: { currentRole: 'reader', currentUser: { projectName: 'Hidden' } },
    } as unknown as Parameters<ACL['parseJsonTemplate']>[1]);
    permissions.set('', { allowed: true, params });
    permissions.set('project', { allowed: true, params: { fields: ['name'] } });
    expect([...(await entryLoad([3]))]).toEqual([['3', null]]);
    await expect(entryLoad([1, 3])).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
  });
  it('entry compiles relational target role facts without granting access to those facts', async () => {
    projects.setField('documents', { type: 'hasMany', target: 'documents', foreignKey: 'projectId' });
    permissions.set('project', {
      allowed: true,
      params: { fields: ['name'], filter: { documents: { name: 'Hidden' } } },
    });
    expect([...(await entryLoad([1, 2, 10]))]).toEqual([
      ['1', { name: 'Owned' }],
      ['2', null],
      ['10', { name: 'Owned' }],
    ]);
    expect(permissionResolver.mock.calls.map(([, path]) => path)).toEqual([[], ['project']]);
  });
  it.each(['source action', 'association field', 'target action', 'target field', 'empty target fields'])(
    'entry rejects missing %s authorization before SQL',
    async (missing) => {
      if (missing === 'source action') permissions.set('', null);
      if (missing === 'association field')
        permissions.set('', { allowed: true, params: { fields: ['id'], appends: [] } });
      if (missing === 'target action') permissions.set('project', { allowed: false, params: {} });
      if (missing === 'target field') permissions.set('project', { allowed: true, params: { fields: ['id'] } });
      if (missing === 'empty target fields') permissions.set('project', { allowed: true, params: { fields: [] } });
      const query = vi.spyOn(db.sequelize, 'query');
      await expect(entryLoad()).rejects.toThrow(/authorized/);
      expect(query).not.toHaveBeenCalled();
    },
  );
  it('entry provides the trusted expansion operation to the existing permission protocol', async () => {
    permissionResolver.mockImplementation((_collection: Collection, _path: readonly string[], operation) => {
      expect(operation.kind).toBe('expandBelongsTo');
      expect(operation.context).toBe(ctx);
      expect(operation.source).toEqual(mainIdentity);
      expect(operation.authenticated).toEqual(authenticated);
      return { allowed: true, params: {} };
    });
    expect([...(await entryLoad([1]))]).toEqual([['1', { name: 'Owned' }]]);
  });
  it('entry preserves non-enumerable field restrictions', async () => {
    permissions.set('project', { allowed: true, params: Object.defineProperty({}, 'fields', { value: ['name'] }) });
    expect([...(await entryLoad([1]))]).toEqual([['1', { name: 'Owned' }]]);
    await expect(entryLoad([1], { targetAttributes: ['secret'] })).rejects.toThrow(/authorized/);
  });
  it('entry returns complete authorized JSON without applying mutation input size limits', async () => {
    const payload = { items: Array.from({ length: 10050 }, (_, index) => index) };
    await projects.model.update({ payload }, { where: { id: 101 } });
    permissions.set('project', { allowed: true, params: { fields: ['payload'] } });
    expect([...(await entryLoad([1], { targetAttributes: ['payload'] }))]).toEqual([['1', { payload }]]);
    await expect(entryLoad([1], { targetAttributes: ['secret'] })).rejects.toThrow(/authorized/);
  });
  it.each([
    { sourceWhere: {} },
    { targetWhere: {} },
    { targetBind: {} },
    { include: ['project'] },
    { association: 'project.name' },
    { sourceKeys: ['_'] },
    { sourceKeys: Array(1001).fill(1) },
    { targetAttributes: [] },
    { targetAttributes: ['name', 'name'] },
    { targetAttributes: Array(1) },
  ])('entry rejects unsupported expansion requests %# before SQL', async (extra) => {
    const query = vi.spyOn(db.sequelize, 'query');
    await expect(entryLoad([1], extra)).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
  it('entry validates original request descriptors and array prototypes without invoking accessors', async () => {
    const getter = vi.fn(() => ['secret']);
    const request = { association: 'project', sourceKeys: [1], targetAttributes: ['name'] };
    Object.defineProperty(request, 'targetAttributes', { get: getter });
    await expect(entry.expandBelongsTo(ctx, mainIdentity, authenticated, request)).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
    const fields = ['name'];
    Object.setPrototypeOf(fields, Object.create(Array.prototype));
    await expect(entryLoad([1], { targetAttributes: fields })).rejects.toThrow();
  });
  it('entry snapshots target permissions and request fields before any authorization awaits', async () => {
    const permission = { allowed: true, params: { fields: ['name'], filter: { name: 'Owned' } } };
    permissions.set('project', permission);
    const keys = [1];
    const fields = ['name'];
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
      permission.params.filter.name = 'Visible';
      permission.params.fields.push('secret');
      keys[0] = 2;
      fields.push('secret');
      return original(...args);
    });
    expect([...(await entryLoad(keys, { targetAttributes: fields }))]).toEqual([['1', { name: 'Owned' }]]);
    expect([...(await entryLoad([2]))]).toEqual([['2', { name: 'Visible' }]]);
  });
  it('entry isolates overlapping reads for different trusted tenant identities', async () => {
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
      params: path.length
        ? { fields: ['name'], filter: { name: operation.authenticated.tenantId === 'B' ? 'Owned' : 'Hidden' } }
        : {},
    }));
    const first = entryLoad([1]);
    try {
      await Promise.race([started, first]);
      expect([
        ...(await entry.expandBelongsTo(
          ctx,
          mainIdentity,
          { tenantId: 'C' },
          {
            association: 'project',
            sourceKeys: [7],
            targetAttributes: ['name'],
          },
        )),
      ]).toEqual([['7', null]]);
    } finally {
      resume();
    }
    expect([...(await first)]).toEqual([['1', { name: 'Owned' }]]);
  });
  it('entry keeps authorization queries constant for 20 and 100 sources', async () => {
    projects.setField('documents', { type: 'hasMany', target: 'documents', foreignKey: 'projectId' });
    permissions.set('', { allowed: true, params: { appends: ['project'], filter: { project: { name: 'Owned' } } } });
    permissions.set('project', {
      allowed: true,
      params: { fields: ['name'], filter: { documents: { name: 'Owned' } } },
    });
    const keys = Array.from({ length: 100 }, (_, index) => index + 100);
    await docs.model.bulkCreate(keys.map((id) => ({ id, tenantId: 'B', name: 'Owned', projectId: 101 })));
    const query = vi.spyOn(db.sequelize, 'query');
    expect((await entryLoad(keys.slice(0, 20))).size).toBe(20);
    const count = query.mock.calls.length;
    query.mockClear();
    const result = await entryLoad(keys);
    expect(result.size).toBe(100);
    expect([...result.values()].every((value) => value?.name === 'Owned')).toBe(true);
    expect(query.mock.calls.length).toBe(count);
    expect(permissionResolver).toHaveBeenCalledTimes(4);
  });
  it('entry does not claim visible historical sources or targets and deduplicates source keys', async () => {
    expect([...(await entryLoad([9, '09', 8]))]).toEqual([
      ['9', { name: 'Legacy' }],
      ['8', { name: 'Owned' }],
    ]);
    expect((await docs.model.findByPk(9))!.getDataValue('tenantId')).toBeNull();
    expect((await projects.model.findByPk(104))!.getDataValue('tenantId')).toBeNull();
    expect((await entryLoad([])).size).toBe(0);
    await expect(
      entry.expandBelongsTo(
        ctx,
        mainIdentity,
        {},
        {
          association: 'project',
          sourceKeys: [],
          targetAttributes: ['name'],
        },
      ),
    ).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
  });
  it('entry uses the live transaction for both source and target reads', async () => {
    const transaction = await db.sequelize.transaction();
    try {
      await docs.model.update({ projectId: 102 }, { where: { id: 1 }, transaction });
      await projects.model.update({ name: 'Changed' }, { where: { id: 102 }, transaction });
      expect([...(await entryLoad([1], { transaction }))]).toEqual([['1', null]]);
    } finally {
      await transaction.rollback();
    }
    expect([...(await entryLoad([1]))]).toEqual([['1', { name: 'Owned' }]]);
    await expect(entryLoad([1], { transaction })).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
  });
  it.each(['source', 'target'])('entry rechecks role-only facts after %s SQL', async (side) => {
    projects.setField('documents', { type: 'hasMany', target: 'documents', foreignKey: 'projectId' });
    permissions.set('project', {
      allowed: true,
      params: { fields: ['name'], filter: { documents: { name: 'Hidden' } } },
    });
    const model = side === 'source' ? docs.model : projects.model;
    const original = model.findAll.bind(model);
    vi.spyOn(model, 'findAll').mockImplementationOnce(async (options) => {
      const records = await original(options);
      (projects.model.associations.documents as unknown as { scope: object }).scope = { name: 'Changed' };
      return records;
    });
    await expect(entryLoad([1])).rejects.toThrow(/changed/);
  });
  it('entry validates target role-only facts during source scope preparation before selecting sources', async () => {
    projects.setField('documents', { type: 'hasMany', target: 'documents', foreignKey: 'projectId' });
    permissions.set('project', { allowed: true, params: { filter: { documents: { name: 'Hidden' } } } });
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      (projects.model.associations.documents as unknown as { scope: object }).scope = { name: 'Changed' };
      return result;
    });
    const find = vi.spyOn(docs.model, 'findAll');
    await expect(entryLoad([1])).rejects.toThrow(/changed/);
    expect(find).not.toHaveBeenCalled();
  });

  it('keeps all readable roots and represents hidden missing and empty targets as null', async () => {
    const result = await load();
    expect([...result]).toEqual([
      ['1', { name: 'Owned' }],
      ['2', { name: 'Visible' }],
      ['3', null],
      ['4', { name: 'Legacy' }],
      ['5', null],
      ['6', null],
    ]);
  });
  it('reads visibility-only and historical sources and targets without claiming them', async () => {
    expect([...(await load([8, 9]))]).toEqual([
      ['8', { name: 'Owned' }],
      ['9', { name: 'Legacy' }],
    ]);
    expect((await docs.model.findByPk(9))!.getDataValue('tenantId')).toBeNull();
    expect((await projects.model.findByPk(104))!.getDataValue('tenantId')).toBeNull();
  });
  it('rejects the entire source batch when any root is hidden or missing', async () => {
    for (const keys of [
      [1, 7],
      [1, 999],
    ])
      await expect(load(keys)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
  });
  it('intersects source and target ACL separately', async () => {
    await expect(load([1, 8], { sourceWhere: { name: 'Owned' } })).rejects.toMatchObject({
      code: 'ACCESS_RECORD_UNAVAILABLE',
    });
    expect([...(await load([1, 2], { targetWhere: { id: { [Op.gt]: 101 } } }))]).toEqual([
      ['1', null],
      ['2', { name: 'Visible' }],
    ]);
  });
  it('selects only approved physical fields and omits internal keys from output', async () => {
    expect([...(await load([1], { targetAttributes: ['name'] }))]).toEqual([['1', { name: 'Owned' }]]);
    expect([...(await load([1], { targetAttributes: ['id', 'name'] }))]).toEqual([['1', { id: 101, name: 'Owned' }]]);
  });
  it('deduplicates source and target keys while preserving source input order', async () => {
    expect([...(await load([10, '01', 1, 10]))]).toEqual([
      ['10', { name: 'Owned' }],
      ['1', { name: 'Owned' }],
    ]);
  });
  it('returns an empty map for an empty page', async () => {
    expect((await load([])).size).toBe(0);
  });
  it('preserves independent named bindings even when their names are identical', async () => {
    expect([
      ...(await load([1], {
        sourceWhere: literal('"documents"."name" = $same'),
        sourceBind: { same: 'Owned' },
        targetWhere: literal('"projects"."name" = $same'),
        targetBind: { same: 'Visible' },
      })),
    ]).toEqual([['1', null]]);
  });
  it('retains target association scope', async () => {
    docs.setField('visibleProject', {
      type: 'belongsTo',
      target: 'projects',
      foreignKey: 'projectId',
      scope: { name: 'Visible' },
    });
    expect([...(await load([1, 2], { association: 'visibleProject' }))]).toEqual([
      ['1', null],
      ['2', { name: 'Visible' }],
    ]);
  });
  it('retains source and target default scopes', async () => {
    projects.model.addScope('defaultScope', { where: { name: 'Visible' } }, { override: true });
    expect([...(await load([1, 2]))]).toEqual([
      ['1', null],
      ['2', { name: 'Visible' }],
    ]);
    docs.model.addScope('defaultScope', { where: { name: 'Visible' } }, { override: true });
    await expect(load([1])).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
  });
  it('retains target soft deletion', async () => {
    projects.model.options.paranoid = true;
    (projects.model as unknown as { _timestampAttributes: Record<string, string> })._timestampAttributes.deletedAt =
      'deletedAt';
    await projects.model.update({ deletedAt: new Date() }, { where: { id: 101 } });
    expect([...(await load([1]))]).toEqual([['1', null]]);
  });
  it('uses the live transaction for source and target reads', async () => {
    const transaction = await db.sequelize.transaction();
    try {
      await docs.model.update({ projectId: 102 }, { where: { id: 1 }, transaction });
      await projects.model.update({ name: 'Changed' }, { where: { id: 102 }, transaction });
      // This target no longer matches V, so it must be null inside this transaction.
      expect([...(await load([1], { transaction }))]).toEqual([['1', null]]);
    } finally {
      await transaction.rollback();
    }
    expect([...(await load([1]))]).toEqual([['1', { name: 'Owned' }]]);
  });
  it('rejects completed and foreign transactions', async () => {
    const ended = await db.sequelize.transaction();
    await ended.rollback();
    await expect(load([1], { transaction: ended })).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
    const foreignDb = sqliteDatabase();
    const foreign = await foreignDb.sequelize.transaction();
    try {
      await expect(load([1], { transaction: foreign })).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
    } finally {
      await foreign.rollback();
      await foreignDb.close();
    }
  });
  it('snapshots caller keys fields and filters before authorization awaits', async () => {
    const keys = [1];
    const fields = ['name'];
    const where = { name: 'Owned' };
    const pending = load(keys, { targetAttributes: fields, targetWhere: where });
    keys[0] = 7;
    fields.push('secret');
    where.name = 'Hidden';
    expect([...(await pending)]).toEqual([['1', { name: 'Owned' }]]);
  });
  it('rejects missing tenant context even for an empty source page', async () => {
    await expect(
      expansion.load(
        ctx,
        mainIdentity,
        target,
        {},
        { association: 'project', sourceKeys: [], targetAttributes: ['name'] },
      ),
    ).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
  });
  it('rejects unprepared and wrong target identities', async () => {
    for (const identity of [{ ...target, collectionKey: 'wrong' }, { ...target, dataSourceKey: 'other' }, mainIdentity])
      await expect(
        expansion.load(ctx, mainIdentity, identity, authenticated, {
          association: 'project',
          sourceKeys: [1],
          targetAttributes: ['name'],
        }),
      ).rejects.toThrow();
  });
  it.each([
    { sourceKeys: [1.5] },
    { sourceKeys: ['_'] },
    { sourceKeys: Array(1001).fill(1) },
    { targetAttributes: ['missing'] },
    { targetAttributes: ['project'] },
    { targetAttributes: [] },
    { targetAttributes: [['name', 'alias']] },
    { include: ['project'] },
    { limit: 1 },
    { targetBind: [1] },
  ])('rejects unsupported expansion input %#', async (extra) => {
    await expect(load([1], extra)).rejects.toThrow();
  });
  it('does not return a late result after the request phase ends', async () => {
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
      const scoped = await original(...args);
      adapter.release(ctx);
      return scoped;
    });
    await expect(load([1])).rejects.toMatchObject({ code: 'INVALID_ACCESS_CONFIG_WRITE' });
  });
  it('supports a registered same-model belongs-to without recursively expanding', async () => {
    docs.setField('parent', { type: 'belongsTo', target: 'documents', foreignKey: 'projectId' });
    await docs.model.update({ projectId: 8 }, { where: { id: 1 } });
    const result = await expansion.load(ctx, mainIdentity, mainIdentity, authenticated, {
      association: 'parent',
      sourceKeys: [1],
      targetAttributes: ['name'],
    });
    expect([...result]).toEqual([['1', { name: 'Visible' }]]);
    expect([...(await entryLoad([1], { association: 'parent' }))]).toEqual([['1', { name: 'Visible' }]]);
  });
  it('keeps SQL query count constant for 20 and 100 sources', async () => {
    await docs.repository.create({
      values: Array.from({ length: 100 }, (_, i) => ({ id: 200 + i, projectId: 101, tenantId: 'B', name: 'Owned' })),
    });
    const messages: string[] = [];
    const runtime = db.sequelize as unknown as { options: { logging: false | ((sql: string) => void) } };
    const logging = runtime.options.logging;
    runtime.options.logging = (sql) => messages.push(sql);
    try {
      expect((await load(Array.from({ length: 20 }, (_, i) => 200 + i))).size).toBe(20);
      const before = messages.length;
      messages.length = 0;
      expect((await load(Array.from({ length: 100 }, (_, i) => 200 + i))).size).toBe(100);
      expect(messages).toHaveLength(before);
      expect(before).toBeLessThanOrEqual(4);
    } finally {
      runtime.options.logging = logging;
    }
  });

  it('reads explicitly shared targets that have no tenant column', async () => {
    const users = db.collection({
      name: 'users',
      tableName: 'expand_users',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'name', type: 'string' },
      ],
    });
    await users.model.sync();
    await users.repository.create({ values: { id: 101, name: 'Shared user' } });
    docs.setField('user', { type: 'belongsTo', target: 'users', foreignKey: 'projectId' });
    const identity = { ...target, collectionName: 'users', collectionKey: 'users-key' };
    await db
      .getRepository('collections')
      .create({ values: { key: identity.collectionKey, name: identity.collectionName } });
    await store.save(
      identity,
      { ...configFor({ type: 'constant', value: true }), ownership: { enabled: false }, revision: 0 },
      { userId: 28 },
    );
    const phase = {};
    await adapter.prepare(phase, [mainIdentity, identity]);
    expect(users.model.rawAttributes.tenantId).toBeUndefined();
    expect([
      ...(await entry.expandBelongsTo(phase, mainIdentity, authenticated, {
        association: 'user',
        sourceKeys: [1],
        targetAttributes: ['name'],
      })),
    ]).toEqual([['1', { name: 'Shared user' }]]);
    expect([
      ...(await expansion.load(phase, mainIdentity, identity, authenticated, {
        association: 'user',
        sourceKeys: [1],
        targetAttributes: ['name'],
      })),
    ]).toEqual([['1', { name: 'Shared user' }]]);
  });
  it('hides every target when its migrated configuration grants no read scope', async () => {
    const before = adapter.configuration(ctx, target)!;
    await store.save(target, { ...before, rules: [] }, { userId: 28 });
    adapter.release(ctx);
    ctx = {};
    await adapter.prepare(ctx, [mainIdentity, target]);
    expect([...(await load([1, 2]))]).toEqual([
      ['1', null],
      ['2', null],
    ]);
  });
  it('applies relational target visibility in SQL', async () => {
    projects.setField('documents', { type: 'hasMany', target: 'documents', foreignKey: 'projectId' });
    const before = adapter.configuration(ctx, target)!;
    const config = configFor(
      {
        type: 'exists',
        path: 'documents',
        condition: {
          type: 'compare',
          operator: 'eq',
          left: { type: 'field', path: 'name' },
          right: { type: 'literal', value: 'Visible' },
        },
      },
      'visibility',
    );
    await store.save(target, { ...config, revision: before.revision }, { userId: 28 });
    adapter.release(ctx);
    ctx = {};
    await adapter.prepare(ctx, [mainIdentity, target]);
    expect([...(await load([1, 2]))]).toEqual([
      ['1', { name: 'Owned' }],
      ['2', null],
    ]);
  });
  it('retains source soft deletion', async () => {
    docs.model.options.paranoid = true;
    (docs.model as unknown as { _timestampAttributes: Record<string, string> })._timestampAttributes.deletedAt =
      'deletedAt';
    await docs.model.update({ deletedAt: new Date() }, { where: { id: 1 } });
    await expect(load([1])).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
  });
  it('rejects changes to an association used by relational visibility', async () => {
    projects.setField('documents', { type: 'hasMany', target: 'documents', foreignKey: 'projectId' });
    const before = adapter.configuration(ctx, target)!;
    const config = configFor(
      {
        type: 'exists',
        path: 'documents',
        condition: {
          type: 'compare',
          operator: 'eq',
          left: { type: 'field', path: 'name' },
          right: { type: 'literal', value: 'Visible' },
        },
      },
      'visibility',
    );
    await store.save(target, { ...config, revision: before.revision }, { userId: 28 });
    adapter.release(ctx);
    ctx = {};
    await adapter.prepare(ctx, [mainIdentity, target]);
    const original = projects.model.findAll.bind(projects.model);
    vi.spyOn(projects.model, 'findAll').mockImplementationOnce(async (options) => {
      const records = await original(options);
      (projects.model.associations.documents as unknown as { scope: object }).scope = { name: 'Hidden' };
      return records;
    });
    await expect(load([1])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });
  it('ignores custom physical getters and rejects virtual projection', async () => {
    projects.setField('derived', { type: 'virtual', get: () => 'Secret' });
    const getter = vi.fn(() => 'Secret');
    projects.model.rawAttributes.name.get = getter;
    (projects.model as unknown as { refreshAttributes(): void }).refreshAttributes();
    expect([...(await load([1]))]).toEqual([['1', { name: 'Owned' }]]);
    expect(getter).not.toHaveBeenCalled();
    await expect(load([1], { targetAttributes: ['derived'] })).rejects.toMatchObject({
      code: 'INVALID_ACCESS_MUTATION',
    });
  });
  it.each(['source', 'target'])('rejects model column changes after the %s SQL read', async (side) => {
    const model = side === 'source' ? docs.model : projects.model;
    const original = model.findAll.bind(model);
    vi.spyOn(model, 'findAll').mockImplementationOnce(async (options) => {
      const records = await original(options);
      model.rawAttributes.name.field = 'secret';
      return records;
    });
    await expect(load([1])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });
  it('rejects late default-scope changes', async () => {
    const original = projects.model.findAll.bind(projects.model);
    vi.spyOn(projects.model, 'findAll').mockImplementationOnce(async (options) => {
      const records = await original(options);
      projects.model.addScope('defaultScope', { where: { name: 'Hidden' } }, { override: true });
      return records;
    });
    await expect(load([1])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });
  it('rejects association replacement during a read', async () => {
    const original = docs.model.findAll.bind(docs.model);
    vi.spyOn(docs.model, 'findAll').mockImplementationOnce(async (options) => {
      const records = await original(options);
      docs.setField('project', { type: 'belongsTo', target: 'projects', foreignKey: 'projectId' });
      return records;
    });
    await expect(load([1])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });
  it('rejects configuration replacement during target authorization', async () => {
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementation(async (...args) => {
      const scoped = await original(...args);
      if (args[1].collectionName === 'projects') {
        adapter.release(ctx);
        await adapter.prepare(ctx, [mainIdentity, target]);
      }
      return scoped;
    });
    await expect(load([1])).rejects.toThrow();
  });
  it('rejects unsupported options and predicates without invoking their accessors', async () => {
    const getter = vi.fn(() => ['secret']);
    for (const extra of [
      Object.defineProperty({}, 'targetAttributes', { enumerable: true, get: getter }),
      { targetWhere: Object.defineProperty({}, 'name', { enumerable: true, get: getter }) },
    ]) {
      const request = { association: 'project', sourceKeys: [1], targetAttributes: ['name'] };
      Object.defineProperties(request, Object.getOwnPropertyDescriptors(extra));
      await expect(expansion.load(ctx, mainIdentity, target, authenticated, request)).rejects.toMatchObject({
        code: 'INVALID_ACCESS_MUTATION',
      });
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it.each([{ sourceKeys: Array(1) }, { targetAttributes: Array(1) }])(
    'rejects sparse key and projection arrays %#',
    async (extra) => {
      await expect(load([1], extra)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    },
  );
});

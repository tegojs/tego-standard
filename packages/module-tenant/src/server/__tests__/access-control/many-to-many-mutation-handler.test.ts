import { ACL, Resourcer, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { AccessReferenceMutationHandler } from '../../access-control/reference-mutation-handler';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const projectIdentity = { ...mainIdentity, collectionKey: 'projects-key', collectionName: 'projects' };
const throughIdentity = { ...mainIdentity, collectionKey: 'documentProjects-key', collectionName: 'documentProjects' };

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('finalized many-to-many mutations (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let projects: Collection;
  let through: Collection;
  let adapter: AccessAclScopeAdapter;
  let store: AccessConfigStore;
  let handler: AccessReferenceMutationHandler;
  const auth = () => ({ tenantId: 'B', roleName: 'editor', userId: 28 });
  const identity = (collection: Collection) =>
    collection === docs ? mainIdentity : collection === through ? throughIdentity : projectIdentity;
  const pg = (name: string, run: () => Promise<void>) => it.skipIf(dialect !== 'postgres')(name, run);

  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    const fields = [
      { name: 'id', type: 'integer', primaryKey: true },
      { name: 'tenantId', type: 'string' },
      { name: 'name', type: 'string' },
    ];
    docs = db.collection({ name: 'documents', timestamps: false, fields });
    projects = db.collection({ name: 'projects', timestamps: false, fields });
    through = db.collection({ name: 'documentProjects', timestamps: false });
    docs.setField('projects', {
      type: 'belongsToMany',
      target: 'projects',
      through: 'documentProjects',
      foreignKey: 'documentId',
      otherKey: 'projectId',
    });
    const tenants = db.collection({
      name: 'tenants',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'enabled', type: 'boolean' },
      ],
    });
    await db.sync();
    await tenants.model.create({ id: 'B', enabled: true });
    await projects.model.bulkCreate([
      { id: 101, tenantId: 'H', name: 'Visible' },
      { id: 102, tenantId: 'C', name: 'Hidden' },
      { id: 103, tenantId: 'B', name: 'Owned' },
      { id: 104, tenantId: null, name: 'Legacy' },
    ]);
    await docs.model.bulkCreate([
      { id: 1, tenantId: 'H', name: 'Visible' },
      { id: 3, tenantId: 'B', name: 'Owned' },
      { id: 5, tenantId: null, name: 'Legacy' },
    ]);
    await through.repository.create({ values: { documentId: 3, projectId: 103 } });
    for (const value of [projectIdentity, throughIdentity])
      await db
        .getRepository('collections')
        .create({ values: { key: value.collectionKey, name: value.collectionName } });
    store = new AccessConfigStore(db, (value) =>
      resolveModelMetadata(db.getCollection(value.collectionName), {
        resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
      }),
    );
    for (const value of [mainIdentity, projectIdentity]) {
      const config = configFor(ownerCondition);
      config.rules.push({
        ...configFor(
          {
            type: 'any',
            children: [
              {
                type: 'compare',
                operator: 'eq',
                left: { type: 'field', path: 'name' },
                right: { type: 'literal', value: 'Visible' },
              },
              { type: 'isNull', operand: { type: 'field', path: 'tenantId' } },
            ],
          },
          'visibility',
        ).rules[0],
        id: 'visible',
      });
      await store.save(value, { ...config, revision: 0 }, { userId: 28 });
    }
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    handler = new AccessReferenceMutationHandler(
      db,
      adapter,
      new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection))),
      identity,
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    throughIdentity.collectionKey = 'documentProjects-key';
    try {
      if (dialect === 'postgres') await db.sequelize.drop({ cascade: true });
    } finally {
      await db.close();
    }
  });

  async function context(
    params: object = {},
    grant: object = {},
    resourceName = 'documents',
    actionName = 'update',
    route?: { resourceName: string; sourceId: string | number },
  ) {
    const acl = new ACL();
    acl.setAvailableAction('update', {});
    acl.setAvailableAction('list', {});
    for (const name of ['add', 'remove', 'set']) acl.setAvailableAction(name, {});
    acl.define({ role: 'editor' }).grantAction(`${resourceName}:${actionName}`, grant);
    const resourcer = new Resourcer();
    resourcer.define({ name: resourceName, actions: { update: {}, list: {}, add: {}, remove: {}, set: {} } });
    const action = resourcer.getAction(resourceName, actionName).clone();
    Object.assign(action, {
      resourceName: route?.resourceName ?? resourceName,
      actionName,
      sourceId: route ? String(route.sourceId) : undefined,
      resourceOf: route ? String(route.sourceId) : undefined,
    });
    action.mergeParams({
      resourceName,
      actionName,
      ...(route ? { associatedName: 'documents', associatedIndex: String(route.sourceId) } : {}),
      ...(actionName === 'update' ? { filterByTk: 3, values: { projects: [101] } } : {}),
      ...params,
    });
    const ctx = {
      db,
      action,
      permission: undefined as unknown,
      body: 'unchanged' as unknown,
      state: { currentRole: 'editor', currentUser: { id: 28, name: 'Owned' } },
      get: () => '+08:00',
      logger: { info: vi.fn() },
      throw: (status: number) => {
        throw new Error(String(status));
      },
    };
    await adapter.prepare(ctx, [mainIdentity, projectIdentity, throughIdentity]);
    await acl.middleware()(ctx as never, async () => {});
    return ctx;
  }
  const target = (grant = {}, params = {}) => context(params, grant, 'projects', 'list');
  const execute = async (ctx: Awaited<ReturnType<typeof context>>, grant = {}, params = {}) => {
    const related = await target(grant, params);
    return handler.handle(ctx, auth(), async () => related);
  };
  const linked = async (id = 3) =>
    (
      await through.model.findAll({
        attributes: ['projectId'],
        where: { documentId: id },
        order: [['projectId', 'ASC']],
      })
    ).map((row) => Number(row.getDataValue('projectId')));

  describe('independent link actions', () => {
    const association = (
      operation = 'add',
      params: object = { values: [101] },
      grant: object = {},
      sourceId: string | number = 3,
    ) => context(params, grant, 'projects', operation, { resourceName: 'documents.projects', sourceId });
    const run = async (ctx: Awaited<ReturnType<typeof context>>, sourceGrant = {}, targetGrant = {}) => {
      const source = await context({}, sourceGrant, 'documents', ctx.action.actionName);
      const read = await target(targetGrant);
      return handler.handleAssociation(
        ctx,
        auth(),
        async () => source,
        async () => read,
      );
    };
    pg('adds using independent source action and target read grants', async () => {
      const ctx = await association();
      await run(ctx, { fields: ['projects'], filter: { name: 'Owned' } }, { fields: ['id'] });
      expect(await linked()).toEqual([101, 103]);
      expect(ctx.body).toEqual({ keys: [3], affected: 1 });
      expect((await projects.model.findByPk(101))!.get('tenantId')).toBe('H');
    });
    pg('accepts core undefined locators on neutral source decisions', async () => {
      const ctx = await association();
      const source = await context({}, {}, 'documents', 'add');
      (source.permission as { rawParams: Record<string, unknown> }).rawParams.filterByTk = undefined;
      const read = await target();
      await handler.handleAssociation(
        ctx,
        auth(),
        async () => source,
        async () => read,
      );
      expect(await linked()).toEqual([101, 103]);
    });
    pg('removes hidden old references without a target list decision', async () => {
      await through.model.update({ projectId: 102 }, { where: { documentId: 3 } });
      const ctx = await association('remove', { filterByTk: 102 });
      const source = await context({}, {}, 'documents', 'remove');
      const read = vi.fn(async () => null);
      await handler.handleAssociation(ctx, auth(), async () => source, read);
      expect(read).not.toHaveBeenCalled();
      expect(await linked()).toEqual([]);
      expect(await projects.model.count()).toBe(4);
    });
    pg('sets and clears without mutating target ownership', async () => {
      await run(await association('set', { filterByTks: [101, 104] }));
      expect(await linked()).toEqual([101, 104]);
      await run(await association('set', { values: [] }));
      expect(await linked()).toEqual([]);
      expect((await projects.model.findByPk(104))!.get('tenantId')).toBeNull();
    });
    pg('keeps unchanged hidden references without extra read authorization', async () => {
      await through.model.update({ projectId: 102 }, { where: { documentId: 3 } });
      const ctx = await association('add', { values: [102] });
      const source = await context({}, {}, 'documents', 'add');
      const read = vi.fn(async () => null);
      await handler.handleAssociation(ctx, auth(), async () => source, read);
      expect(read).not.toHaveBeenCalled();
      expect(ctx.body).toEqual({ keys: [], affected: 0 });
    });
    pg('enforces target action conditions on removed and implicitly removed links', async () => {
      for (const operation of ['remove', 'set']) {
        const ctx = await association(
          operation,
          { values: operation === 'set' ? [101] : [103] },
          { filter: { name: 'Visible' } },
        );
        await expect(run(ctx)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
        expect(await linked()).toEqual([103]);
        expect(ctx.body).toBe('unchanged');
      }
    });
    pg('does not borrow target permission for source conditions or ownership', async () => {
      await expect(run(await association(), { filter: { name: 'Other' } })).rejects.toMatchObject({
        code: 'ACCESS_RECORD_UNAVAILABLE',
      });
      await expect(run(await association('add', { values: [103] }, {}, 1))).rejects.toMatchObject({
        code: 'ACCESS_RECORD_UNAVAILABLE',
      });
      expect(await linked()).toEqual([103]);
      expect(await linked(1)).toEqual([]);
    });
    pg('rejects hidden added targets before changing connections', async () => {
      await expect(run(await association('set', { values: [101, 102] }))).rejects.toMatchObject({
        code: 'ACCESS_RECORD_UNAVAILABLE',
      });
      expect(await linked()).toEqual([103]);
    });
    pg('captures request and identity before asynchronous source authorization', async () => {
      const ctx = await association();
      const source = await context({}, {}, 'documents', 'add');
      const read = await target();
      const actor = auth();
      await handler.handleAssociation(
        ctx,
        actor,
        async () => {
          ctx.action.actionName = 'set';
          (ctx.permission as { rawParams: { values: number[] } }).rawParams.values = [102];
          actor.tenantId = 'C';
          return source;
        },
        async () => read,
      );
      expect(await linked()).toEqual([101, 103]);
    });
    pg('rejects preparation ending during source authorization', async () => {
      const ctx = await association();
      const source = await context({}, {}, 'documents', 'add');
      await expect(
        handler.handleAssociation(
          ctx,
          auth(),
          async () => {
            adapter.release(ctx);
            return source;
          },
          async () => null,
        ),
      ).rejects.toThrow();
      expect(await linked()).toEqual([103]);
    });
    pg('rejects through metadata drift during source authorization', async () => {
      const ctx = await association();
      const source = await context({}, {}, 'documents', 'add');
      await expect(
        handler.handleAssociation(
          ctx,
          auth(),
          async () => {
            through.setField('note', { type: 'string' });
            return source;
          },
          async () => null,
        ),
      ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(await linked()).toEqual([103]);
    });
    pg('claims only editable historical sources', async () => {
      const config = configFor({
        type: 'any',
        children: [ownerCondition, { type: 'isNull', operand: { type: 'field', path: 'tenantId' } }],
      });
      await store.save(
        mainIdentity,
        { ...config, revision: (await store.read(mainIdentity))!.revision },
        { userId: 28 },
      );
      await run(await association('add', { values: [104] }, {}, 5));
      expect((await docs.model.findByPk(5))!.get('tenantId')).toBe('B');
      expect((await projects.model.findByPk(104))!.get('tenantId')).toBeNull();
      expect(await linked(5)).toEqual([104]);
    });
    it.each(['role', 'action', 'resource', 'database', 'filtered', 'locator', 'denied'])(
      'rejects invalid source context %s',
      async (kind) => {
        const ctx = await association();
        const source = await context({}, {}, 'documents', 'add');
        const permission = source.permission as { can: { role: string } | false; rawParams: Record<string, unknown> };
        if (kind === 'role') (permission.can as { role: string }).role = 'other';
        if (kind === 'action') source.action.actionName = 'remove';
        if (kind === 'resource') source.action.resourceName = 'projects';
        if (kind === 'database') Object.assign(source, { db: {} });
        if (kind === 'filtered') permission.rawParams.filter = { name: 'Owned' };
        if (kind === 'locator') permission.rawParams.filterByTk = 3;
        if (kind === 'denied') permission.can = false;
        await expect(
          handler.handleAssociation(
            ctx,
            auth(),
            async () => source,
            async () => null,
          ),
        ).rejects.toThrow();
        expect(await linked()).toEqual([103]);
      },
    );
    it.each([{ fields: ['name'] }, { blacklist: ['projects'] }])(
      'requires source field permission %j',
      async (grant) => {
        await expect(run(await association(), grant)).rejects.toThrow();
        expect(await linked()).toEqual([103]);
      },
    );
    it.each([
      { values: [101], filterByTk: 103 },
      { values: [{ id: 101 }] },
      { values: [] },
      { values: [101], filter: {} },
      { values: [101], associatedIndex: 1 },
      { values: [101], resourceName: 'documents' },
      { values: [101], transaction: {} },
      { values: [101], updateAssociationValues: ['projects'] },
    ])('rejects unsupported association input %j', async (params) => {
      await expect(run(await association('add', params))).rejects.toThrow();
      expect(await linked()).toEqual([103]);
    });
    it('rejects placeholder source writes', async () => {
      await expect(run(await association('set', { values: [] }, {}, '_'))).rejects.toThrow();
    });
    it('rejects a target action bound to another role', async () => {
      const ctx = await association();
      (ctx.permission as { can: { role: string } }).can.role = 'other';
      await expect(run(ctx)).rejects.toThrow();
    });
    it.each([{ fields: ['name'] }, { whitelist: ['name'] }, { blacklist: ['id'] }, { own: true }, { limit: 1 }])(
      'rejects unsupported target action grants %j',
      async (grant) => {
        await expect(run(await association('add', { values: [101] }, grant))).rejects.toMatchObject({
          code: 'INVALID_ACCESS_MUTATION',
        });
        expect(await linked()).toEqual([103]);
      },
    );
    it.each(['denied', 'resource', 'action'])('rejects invalid target action binding %s', async (kind) => {
      const ctx = await association();
      const permission = ctx.permission as { can: unknown; resourceName: string; actionName: string };
      if (kind === 'denied') permission.can = false;
      if (kind === 'resource') permission.resourceName = 'documents';
      if (kind === 'action') permission.actionName = 'set';
      await expect(run(ctx)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(await linked()).toEqual([103]);
    });
    pg('captures target operation conditions before asynchronous source authorization', async () => {
      const ctx = await association('remove', { values: [103] }, { filter: { name: 'Visible' } });
      const source = await context({}, {}, 'documents', 'remove');
      await expect(
        handler.handleAssociation(
          ctx,
          auth(),
          async () => {
            (ctx.permission as { parsedParams: { filter: object } }).parsedParams.filter = {};
            return source;
          },
          async () => null,
        ),
      ).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      expect(await linked()).toEqual([103]);
    });
    pg('applies target action conditions as well as independent list conditions to additions', async () => {
      await expect(
        run(await association('add', { values: [101] }, { filter: { name: 'Owned' } })),
      ).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      expect(await linked()).toEqual([103]);
    });
    pg('authorizes a combined change set larger than the request key limit', async () => {
      const old = Array.from({ length: 600 }, (_, index) => 2000 + index);
      const added = Array.from({ length: 600 }, (_, index) => 3000 + index);
      await projects.model.bulkCreate([...old, ...added].map((id) => ({ id, tenantId: 'B', name: 'Owned' })));
      await through.model.destroy({ where: { documentId: 3 } });
      await through.model.bulkCreate(old.map((projectId) => ({ documentId: 3, projectId })));
      const ctx = await association('set', { values: added }, { filter: { name: 'Owned' } });
      await run(ctx);
      expect(await linked()).toEqual(added);
      expect(ctx.body).toEqual({ keys: [3], affected: 1 });
    });
    pg('rejects identity changes while resolving target list permission and rolls back', async () => {
      const ctx = await association();
      const source = await context({}, {}, 'documents', 'add');
      const read = await target();
      await expect(
        handler.handleAssociation(
          ctx,
          auth(),
          async () => source,
          async () => {
            throughIdentity.collectionKey = 'replacement';
            return read;
          },
        ),
      ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(await linked()).toEqual([103]);
    });
    pg('does not claim a historical source when an added target fails authorization', async () => {
      const config = configFor({
        type: 'any',
        children: [ownerCondition, { type: 'isNull', operand: { type: 'field', path: 'tenantId' } }],
      });
      await store.save(
        mainIdentity,
        { ...config, revision: (await store.read(mainIdentity))!.revision },
        { userId: 28 },
      );
      await expect(run(await association('add', { values: [102] }, {}, 5))).rejects.toMatchObject({
        code: 'ACCESS_RECORD_UNAVAILABLE',
      });
      expect((await docs.model.findByPk(5))!.get('tenantId')).toBeNull();
      expect(await linked(5)).toEqual([]);
    });
    pg('rolls back independent association actions when preparation ends in the final persisted query', async () => {
      const ctx = await association();
      const source = await context({}, {}, 'documents', 'add');
      const read = await target();
      const original = docs.model.findAll.bind(docs.model);
      vi.spyOn(docs.model, 'findAll').mockImplementation(async (...args) => {
        const records = await original(...args);
        const options = args[0] as { transaction?: unknown; lock?: unknown; attributes?: unknown };
        if (options?.transaction && !options.lock && !options.attributes) adapter.release(ctx);
        return records;
      });
      await expect(
        handler.handleAssociation(
          ctx,
          auth(),
          async () => source,
          async () => read,
        ),
      ).rejects.toMatchObject({ code: 'INVALID_ACCESS_CONFIG_WRITE' });
      expect(await linked()).toEqual([103]);
    });
  });

  pg('replaces references using source write and target read permissions without changing targets', async () => {
    const ctx = await context({ values: { projects: [101, 104] } }, { fields: ['projects'] });
    await execute(ctx, { fields: ['id'] });
    expect(await linked()).toEqual([101, 104]);
    expect(ctx.body).toEqual({ keys: [3], affected: 1 });
    expect((await docs.model.findByPk(3))!.get('tenantId')).toBe('B');
    expect((await projects.model.findByPk(101))!.get('tenantId')).toBe('H');
    expect((await projects.model.findByPk(104))!.get('tenantId')).toBeNull();
  });
  pg('authorizes only added targets while preserving hidden existing references', async () => {
    await through.model.update({ projectId: 102 }, { where: { documentId: 3 } });
    const ctx = await context({ values: { projects: [102, 101] } });
    await execute(ctx, { fields: ['id'], filter: { name: 'Visible' } });
    expect(await linked()).toEqual([101, 102]);
  });
  pg('removes hidden old connections without requiring target reads', async () => {
    await through.model.update({ projectId: 102 }, { where: { documentId: 3 } });
    const ctx = await context({ values: { projects: [] } });
    const authorize = vi.fn(async () => null);
    await handler.handle(ctx, auth(), authorize);
    expect(authorize).not.toHaveBeenCalled();
    expect(await linked()).toEqual([]);
    expect(await projects.model.count()).toBe(4);
  });
  pg('keeps unchanged references without target authorization and reports no changed sources', async () => {
    await through.model.update({ projectId: 102 }, { where: { documentId: 3 } });
    const ctx = await context({ values: { projects: [102, '0102'] } });
    const authorize = vi.fn(async () => null);
    await handler.handle(ctx, auth(), authorize);
    expect(authorize).not.toHaveBeenCalled();
    expect(await linked()).toEqual([102]);
    expect(ctx.body).toEqual({ keys: [], affected: 0 });
  });
  pg('does not let visibility authorize a source write', async () => {
    const ctx = await context({ filterByTk: 1 });
    await expect(execute(ctx)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await linked(1)).toEqual([]);
    expect(ctx.body).toBe('unchanged');
  });
  pg('rejects a hidden or missing added target before removing existing links', async () => {
    for (const id of [102, 999]) {
      const ctx = await context({ values: { projects: [101, id] } });
      await expect(execute(ctx)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      expect(await linked()).toEqual([103]);
      expect(ctx.body).toBe('unchanged');
    }
  });
  pg('uses final source conditions rather than merged action params', async () => {
    const ctx = await context({}, { fields: ['projects'], filter: { name: 'Other' } });
    ctx.action.mergeParams({ filter: {} });
    await expect(execute(ctx)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await linked()).toEqual([103]);
  });
  pg('uses independently resolved target conditions', async () => {
    await expect(execute(await context(), { filter: { name: '{{ ctx.state.currentUser.name }}' } })).rejects.toThrow();
    expect(await linked()).toEqual([103]);
  });
  pg('requires a target list decision bound to the same role and database', async () => {
    for (const kind of ['denied', 'role', 'database', 'resource']) {
      const ctx = await context();
      const related = await target();
      if (kind === 'denied') (related.permission as { can: unknown }).can = false;
      if (kind === 'role') (related.permission as { can: { role: string } }).can.role = 'other';
      if (kind === 'database') Object.assign(related, { db: {} });
      if (kind === 'resource') Object.assign(related.action, { resourceName: 'documents' });
      await expect(handler.handle(ctx, auth(), async () => related)).rejects.toThrow();
      expect(await linked()).toEqual([103]);
    }
  });
  pg('requires a neutral target lookup with a readable primary key', async () => {
    await expect(execute(await context(), { fields: ['name'] })).rejects.toThrow();
    await expect(execute(await context(), {}, { filter: { name: 'Visible' } })).rejects.toThrow();
    expect(await linked()).toEqual([103]);
  });
  pg('claims an editable historical source but never the referenced legacy target', async () => {
    const config = configFor({
      type: 'any',
      children: [ownerCondition, { type: 'isNull', operand: { type: 'field', path: 'tenantId' } }],
    });
    await store.save(mainIdentity, { ...config, revision: (await store.read(mainIdentity))!.revision }, { userId: 28 });
    const ctx = await context({ filterByTk: 5, values: { projects: [104] } });
    await execute(ctx);
    expect(await linked(5)).toEqual([104]);
    expect((await docs.model.findByPk(5))!.get('tenantId')).toBe('B');
    expect((await projects.model.findByPk(104))!.get('tenantId')).toBeNull();
  });
  pg('does not claim a historical source when its links do not change', async () => {
    const config = configFor({
      type: 'any',
      children: [ownerCondition, { type: 'isNull', operand: { type: 'field', path: 'tenantId' } }],
    });
    await store.save(mainIdentity, { ...config, revision: (await store.read(mainIdentity))!.revision }, { userId: 28 });
    const ctx = await context({ filterByTk: 5, values: { projects: [] } });
    await handler.handle(ctx, auth(), async () => null);
    expect(ctx.body).toEqual({ keys: [], affected: 0 });
    expect((await docs.model.findByPk(5))!.get('tenantId')).toBeNull();
  });
  pg('keeps historical sources read-only without an ownership grant', async () => {
    await expect(execute(await context({ filterByTk: 5 }))).rejects.toMatchObject({ code: 'LEGACY_DATA_READ_ONLY' });
    expect(await linked(5)).toEqual([]);
  });
  pg('rolls back both removal and insertion if a join hook fails', async () => {
    const ctx = await context();
    const error = new Error('join hook failure');
    through.model.addHook('afterBulkCreate', () => {
      throw error;
    });
    await expect(execute(ctx)).rejects.toBe(error);
    expect(await linked()).toEqual([103]);
    expect(ctx.body).toBe('unchanged');
  });
  pg('rejects metadata drift after the final persisted query', async () => {
    const ctx = await context();
    const related = await target();
    const original = docs.model.findAll.bind(docs.model);
    vi.spyOn(docs.model, 'findAll').mockImplementation(async (...args) => {
      const rows = await original(...args);
      if (
        (args[0] as { hooks?: boolean } | undefined)?.hooks === false &&
        (await through.model.count({
          where: { documentId: 3, projectId: 101 },
          transaction: args[0]?.transaction,
        }))
      )
        docs.options.filterTargetKey = 'name';
      return rows;
    });
    await expect(handler.handle(ctx, auth(), async () => related)).rejects.toThrow();
    expect(ctx.body).toBe('unchanged');
    expect(await linked()).toEqual([103]);
  });
  pg('rechecks the through identity during asynchronous target authorization', async () => {
    const ctx = await context();
    const related = await target();
    await expect(
      handler.handle(ctx, auth(), async () => {
        throughIdentity.collectionKey = 'changed';
        return related;
      }),
    ).rejects.toThrow();
    throughIdentity.collectionKey = 'documentProjects-key';
    expect(await linked()).toEqual([103]);
  });
  pg('rechecks preparation after asynchronous target authorization', async () => {
    const ctx = await context();
    const related = await target();
    await expect(
      handler.handle(ctx, auth(), async () => {
        adapter.release(ctx);
        return related;
      }),
    ).rejects.toThrow();
    expect(await linked()).toEqual([103]);
  });

  it.each([{ fields: ['name'] }, { whitelist: ['projects'], blacklist: ['projects'] }])(
    'requires association field permission %j',
    async (grant) => {
      const ctx = await context({}, grant);
      await expect(execute(ctx)).rejects.toThrow();
      expect(await linked()).toEqual([103]);
    },
  );
  it.each([
    { values: { projects: null } },
    { values: { projects: 101 } },
    { values: { projects: [{ id: 101 }] } },
    { values: { projects: [true] } },
    { values: { projects: [101], name: 'changed' } },
    { values: { projects: [101], tenantId: 'C' } },
    { filterByTk: [3] },
    { filter: {} },
    { appends: ['projects'] },
    { updateAssociationValues: ['projects'] },
    { transaction: {} },
  ])('rejects unsupported request shapes %j', async (params) => {
    const ctx = await context(params);
    await expect(execute(ctx)).rejects.toThrow();
    expect(await linked()).toEqual([103]);
    expect(ctx.body).toBe('unchanged');
  });
  it.each(['sparse', 'prototype', 'symbol', 'oversized'])('rejects malformed %s key arrays', async (kind) => {
    const input: unknown[] = [101];
    if (kind === 'sparse') input.length = 2;
    if (kind === 'prototype') Object.setPrototypeOf(input, { ...Array.prototype });
    if (kind === 'symbol') Object.assign(input, { [Symbol('bad')]: 102 });
    if (kind === 'oversized') input.push(...Array.from({ length: 1000 }, () => 101));
    const ctx = await context({ values: { projects: input } });
    (ctx.permission as { rawParams: { values: unknown } }).rawParams.values = { projects: input };
    await expect(execute(ctx)).rejects.toThrow();
    expect(await linked()).toEqual([103]);
  });
  it('rejects business fields on the through table', async () => {
    through.setField('note', { type: 'string' });
    const ctx = await context();
    await expect(execute(ctx)).rejects.toThrow();
  });
  it('rejects independently controlled through records', async () => {
    through.setField('tenantId', { type: 'string' });
    await store.save(throughIdentity, { ...configFor(ownerCondition), revision: 0 }, { userId: 28 });
    await expect(execute(await context())).rejects.toThrow();
  });
  it('explicitly refuses writes on unsupported dialects', async () => {
    if (dialect === 'postgres') return;
    const ctx = await context();
    await expect(execute(ctx)).rejects.toMatchObject({ code: 'UNSUPPORTED_ACCESS_MUTATION' });
    expect(await linked()).toEqual([103]);
  });
});

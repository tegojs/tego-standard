import { ACL, Resourcer, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import {
  accessCollectionKey,
  AccessConfigStore,
  type AccessCollectionIdentity,
} from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { AccessResourceMutationHandler } from '../../access-control/resource-mutation-handler';
import { AccessRootReadHandler } from '../../access-control/root-read-handler';
import type { AccessConfig } from '../../access-control/types';
import { seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const names = ['documents', 'projects', 'children', 'profiles', 'links'] as const;
const actions = ['create', 'update', 'list', 'add', 'remove', 'set'];
const actor = { tenantId: 'B', userId: 28, roleName: 'editor' };
const identity = (collection: Collection, dataSourceKey = 'external'): AccessCollectionIdentity => ({
  dataSourceKey,
  collectionName: collection.name,
  collectionKey: `${dataSourceKey === 'main' ? '' : `${dataSourceKey}-`}${collection.name}-key`,
});
const scope = (owned: number[], visible: number[]): AccessConfig => ({
  ...configFor({
    type: 'compare',
    operator: 'in',
    left: { type: 'field', path: 'id' },
    right: { type: 'literal', value: owned },
  }),
  ownership: { enabled: false },
  rules: [
    configFor({
      type: 'compare',
      operator: 'in',
      left: { type: 'field', path: 'id' },
      right: { type: 'literal', value: owned },
    }).rules[0],
    {
      ...configFor(
        {
          type: 'compare',
          operator: 'in',
          left: { type: 'field', path: 'id' },
          right: { type: 'literal', value: visible },
        },
        'visibility',
      ).rules[0],
      id: 'visible',
    },
  ],
});
const shared = (): AccessConfig => ({ ...configFor({ type: 'constant', value: true }), ownership: { enabled: false } });

describe.skipIf(!postgresUrl)('external association write boundaries', () => {
  let primary: Database;
  let external: Database;
  let store: AccessConfigStore;
  let adapter: AccessAclScopeAdapter;
  let handler: AccessResourceMutationHandler;

  beforeEach(async () => {
    primary = sqliteDatabase();
    external = isolatedPostgresDatabase(postgresUrl!);
    await seedConfigStore(primary);
    for (const db of [primary, external]) {
      for (const name of names.filter((name) => name !== 'links'))
        db.collection({
          name,
          timestamps: false,
          fields: [
            { name: 'id', type: 'integer', primaryKey: true },
            { name: 'name', type: 'string' },
            { name: 'tenantId', type: 'string' },
          ],
        });
      db.collection({ name: 'links', timestamps: false });
      const docs = db.getCollection('documents');
      docs.setField('project', { type: 'belongsTo', target: 'projects', foreignKey: 'projectId' });
      docs.setField('projects', {
        type: 'belongsToMany',
        target: 'projects',
        through: 'links',
        foreignKey: 'documentId',
        otherKey: 'projectId',
      });
      docs.setField('children', { type: 'hasMany', target: 'children', foreignKey: 'documentId' });
      docs.setField('profiles', { type: 'hasOne', target: 'profiles', foreignKey: 'documentId' });
      db.collection({
        name: 'tenants',
        autoGenId: false,
        timestamps: false,
        fields: [
          { name: 'id', type: 'string', primaryKey: true },
          { name: 'enabled', type: 'boolean' },
        ],
      });
      await db.sync();
      await db.getCollection('tenants').model.create({ id: 'B', enabled: db === external });
      await docs.model.bulkCreate([
        { id: 1, name: 'Owned', tenantId: 'B', projectId: 11 },
        { id: 2, name: 'Visible', tenantId: 'H', projectId: 11 },
      ]);
      for (const name of ['projects', 'children', 'profiles'])
        await db.getCollection(name).model.bulkCreate([
          { id: 11, name: db === external ? 'External owned' : 'Main owned', tenantId: 'B' },
          { id: 12, name: db === external ? 'External visible' : 'Main visible', tenantId: 'H' },
          { id: 13, name: 'Hidden', tenantId: 'C' },
          { id: 14, name: 'Legacy', tenantId: null },
        ]);
      await db.getCollection('links').model.create({ documentId: 1, projectId: 11 });
    }
    store = new AccessConfigStore(primary, (value) => {
      const db = value.dataSourceKey === 'main' ? primary : external;
      return resolveModelMetadata(db.getCollection(value.collectionName), {
        resolveCollectionKey: (collection) => accessCollectionKey(identity(collection, value.dataSourceKey)),
      });
    });
    for (const dataSourceKey of ['main', 'external'])
      for (const name of names) {
        const db = dataSourceKey === 'main' ? primary : external;
        const value = identity(db.getCollection(name), dataSourceKey);
        if (name !== 'documents')
          await primary.getRepository(dataSourceKey === 'main' ? 'collections' : 'dataSourcesCollections').create({
            values: { key: value.collectionKey, name, ...(dataSourceKey === 'main' ? {} : { dataSourceKey }) },
          });
        // Plain connection records have no independent access configuration.
        if (name === 'links') continue;
        const config =
          dataSourceKey === 'main' || name === 'links'
            ? shared()
            : name === 'documents'
              ? scope([1, 3], [2])
              : scope([11], [12, 14]);
        await store.save(value, { ...config, revision: 0 }, { userId: 28 });
      }
    adapter = new AccessAclScopeAdapter(new ACL(), 'external', store, external);
    handler = new AccessResourceMutationHandler(
      external,
      adapter,
      new AccessQueryService(external, adapter, (collection) => accessCollectionKey(identity(collection))),
      identity,
    );
  });

  afterEach(async () => {
    try {
      if (external) await external.sequelize.drop({ cascade: true });
    } finally {
      await Promise.all([primary?.close(), external?.close()]);
    }
  });

  async function configure(name: string, config: AccessConfig) {
    const value = identity(external.getCollection(name));
    const previous = await store.read(value);
    await store.save(value, { ...config, revision: previous?.revision ?? 0 }, { userId: 28 });
  }

  async function context(resourceName: string, actionName: string, params: object = {}, grant = {}, source?: string) {
    const acl = new ACL();
    for (const action of actions) acl.setAvailableAction(action, {});
    acl.define({ role: actor.roleName }).grantAction(`${resourceName}:${actionName}`, grant);
    const resourcer = new Resourcer();
    resourcer.define({ name: resourceName, actions: Object.fromEntries(actions.map((name) => [name, {}])) });
    const action = resourcer.getAction(resourceName, actionName).clone();
    Object.assign(action, {
      resourceName: source === undefined ? resourceName : `documents.${resourceName}`,
      actionName,
      sourceId: source,
      resourceOf: source,
    });
    action.mergeParams({
      resourceName,
      actionName,
      filterByTk: undefined,
      ...(source === undefined ? {} : { associatedName: 'documents', associatedIndex: source }),
      ...params,
    });
    const ctx = {
      db: external,
      action,
      body: 'unchanged' as unknown,
      permission: undefined as unknown,
      state: { currentRole: actor.roleName, currentUser: { id: actor.userId } },
      get: () => '+08:00',
      logger: { info: vi.fn() },
      throw: (status: number) => {
        throw new Error(String(status));
      },
    };
    await adapter.prepare(
      ctx,
      names.map((name) => identity(external.getCollection(name))),
    );
    await acl.middleware()(ctx as never, async () => {});
    return ctx;
  }
  const root = (values: object, id = 1) => context('documents', 'update', { filterByTk: id, values });
  async function run(ctx: Awaited<ReturnType<typeof context>>, targetReadGrant = {}, targetUpdateGrant = {}) {
    const related: Array<Awaited<ReturnType<typeof context>>> = [];
    const decision = async (collection: Collection, action: string, grant: object) => {
      const result = await context(collection.name, action, {}, grant);
      related.push(result);
      return result;
    };
    try {
      await handler.handle(ctx, actor, {
        read: (collection) => decision(collection, 'list', targetReadGrant),
        update: (collection) => decision(collection, 'update', targetUpdateGrant),
        source: (collection, operation) => decision(collection, operation, {}),
      });
    } finally {
      for (const entry of [ctx, ...related]) adapter.release(entry);
    }
    return ctx.body;
  }
  const row = async (name: string, id: number) => (await external.getCollection(name).model.findByPk(id))?.toJSON();
  const links = async () =>
    (await external.getCollection('links').model.findAll({ order: [['projectId', 'ASC']] })).map((record) =>
      Number(record.get('projectId')),
    );
  async function snapshot(db: Database) {
    return Promise.all(
      names.map(async (name) =>
        (
          await db.getCollection(name).model.findAll({
            order:
              name === 'links'
                ? [
                    ['documentId', 'ASC'],
                    ['projectId', 'ASC'],
                  ]
                : [['id', 'ASC']],
          })
        ).map((record) => record.toJSON()),
      ),
    );
  }
  async function unchanged(ctx: Awaited<ReturnType<typeof context>>, execute = () => run(ctx)) {
    const before = await snapshot(external);
    const mainBefore = await snapshot(primary);
    await expect(execute()).rejects.toThrow();
    expect(await snapshot(external)).toEqual(before);
    expect(await snapshot(primary)).toEqual(mainBefore);
    expect(ctx.body).toBe('unchanged');
  }

  it.each([12, 14])('references a visible target %s without editing or claiming it', async (id) => {
    const targetBefore = await row('projects', id);
    const mainBefore = await snapshot(primary);
    const ctx = await root({ name: 'Edited', project: id });
    expect(await run(ctx)).toEqual({ keys: [1], affected: 1 });
    expect(await row('documents', 1)).toMatchObject({ name: 'Edited', projectId: id, tenantId: 'B' });
    expect(await row('projects', id)).toEqual(targetBefore);
    expect(await snapshot(primary)).toEqual(mainBefore);
  });

  it('creates an unmanaged source with a readable reference and no injected owner', async () => {
    const targetBefore = await row('projects', 12);
    const ctx = await context('documents', 'create', { values: { id: 3, name: 'Created', project: 12 } });
    expect(await run(ctx)).toEqual({ keys: [3], affected: 1 });
    expect(await row('documents', 3)).toMatchObject({ id: 3, projectId: 12, tenantId: null });
    expect(await row('projects', 12)).toEqual(targetBefore);
    expect(await primary.getCollection('documents').model.findByPk(3)).toBeNull();
  });

  it('updates references of both supported types in the external source transaction', async () => {
    const targetsBefore = await external
      .getCollection('projects')
      .model.findAll({ order: [['id', 'ASC']] })
      .then((rows) => rows.map((r) => r.toJSON()));
    const ctx = await root({ name: 'Edited', project: 12, projects: [11, 12] });
    await run(ctx);
    expect(await row('documents', 1)).toMatchObject({ name: 'Edited', projectId: 12, tenantId: 'B' });
    expect(await links()).toEqual([11, 12]);
    expect(
      await external
        .getCollection('projects')
        .model.findAll({ order: [['id', 'ASC']] })
        .then((rows) => rows.map((r) => r.toJSON())),
    ).toEqual(targetsBefore);
    expect(await primary.getCollection('links').model.count()).toBe(1);
  });

  it.each(['add', 'remove', 'set'] as const)('executes concrete external connection %s', async (operation) => {
    const ctx = await context('projects', operation, { values: operation === 'remove' ? [11] : [12] }, {}, '1');
    await run(ctx);
    expect(await links()).toEqual(operation === 'add' ? [11, 12] : operation === 'remove' ? [] : [12]);
    expect(await row('documents', 1)).toMatchObject({ tenantId: 'B' });
    expect(await row('projects', 12)).toMatchObject({ name: 'External visible', tenantId: 'H' });
    expect(await primary.getCollection('links').model.count()).toBe(1);
  });

  it.each(['children', 'profiles'] as const)('assigns a writable external %s target', async (name) => {
    const ctx = await root({ name: 'Edited', [name]: name === 'children' ? [11] : 11 });
    await run(ctx);
    expect(await row(name, 11)).toMatchObject({ documentId: 1, tenantId: 'B' });
    expect(await row('documents', 1)).toMatchObject({ name: 'Edited', tenantId: 'B' });
    expect((await primary.getCollection(name).model.findByPk(11))?.get('documentId')).toBeNull();
  });

  it.each(['children', 'profiles'] as const)('cannot modify a visibility-only external %s target', async (name) => {
    const ctx = await root({ name: 'Denied', [name]: name === 'children' ? [12] : 12 });
    await unchanged(ctx);
  });

  it.each([{ project: 13 }, { projects: [13] }])(
    'cannot reference an unreadable external target %j',
    async (values) => {
      await unchanged(await root({ name: 'Denied', ...values }));
    },
  );

  it('intersects independently finalized target list conditions when changing a reference', async () => {
    const ctx = await root({ name: 'Denied', project: 12 });
    await unchanged(ctx, () => run(ctx, { filter: { id: 11 } }));
  });

  it.each(['children', 'profiles'] as const)('retains target update ACL conditions for %s', async (name) => {
    const ctx = await root({ name: 'Denied', [name]: name === 'children' ? [11] : 11 });
    await unchanged(ctx, () => run(ctx, {}, { filter: { id: 12 } }));
  });

  it('cannot modify a source made readable only by V', async () => {
    await unchanged(await root({ project: 12 }, 2));
  });

  it.each([
    ['projects', { project: 11 }],
    ['projects', { projects: [11] }],
    ['children', { children: [11] }],
    ['profiles', { profiles: 11 }],
    ['links', { projects: [12] }],
  ] as const)('rejects tenant-aware external %s during a root relation update %j', async (name, values) => {
    await configure(name, configFor(name === 'links' ? { type: 'constant', value: true } : ownerCondition));
    const ctx = await root({ name: 'Denied', ...values });
    const before = await snapshot(external);
    await expect(run(ctx)).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
    expect(await snapshot(external)).toEqual(before);
    expect(ctx.body).toBe('unchanged');
  });

  it('does not treat conditionally controlled connection records as ordinary links', async () => {
    await configure('links', {
      ...shared(),
      rules: configFor({
        type: 'compare',
        operator: 'eq',
        left: { type: 'field', path: 'projectId' },
        right: { type: 'literal', value: 11 },
      }).rules,
    });
    const ctx = await root({ projects: [12] });
    const before = await snapshot(external);
    await expect(run(ctx)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await snapshot(external)).toEqual(before);
    expect(ctx.body).toBe('unchanged');
  });

  it.each(['constant', 'logical'] as const)(
    'uses one %s shared connection configuration for both writes and reads',
    async (kind) => {
      const config = shared();
      if (kind === 'logical')
        config.rules[0].condition = {
          type: 'any',
          children: [
            { type: 'constant', value: false },
            { type: 'constant', value: true },
          ],
        };
      await configure('links', config);
      const write = await root({ name: 'Edited', projects: [11, 12] });
      expect(await run(write)).toEqual({ keys: [1], affected: 1 });
      const read = await context('projects', 'list', { fields: ['id'], sort: 'id' }, {}, '1');
      const related: Array<Awaited<ReturnType<typeof context>>> = [];
      try {
        const reader = new AccessRootReadHandler(
          external,
          adapter,
          new AccessQueryService(external, adapter, (collection) => accessCollectionKey(identity(collection))),
          identity,
        );
        await reader.handleResourceWithRelatedContexts(read, actor, async (collection) => {
          const result = await context(collection.name, 'list');
          related.push(result);
          return result;
        });
        expect(read.body).toMatchObject({ rows: [{ id: 11 }, { id: 12 }], count: 2 });
      } finally {
        for (const entry of [read, ...related]) adapter.release(entry);
      }
      expect(await links()).toEqual([11, 12]);
      expect(await primary.getCollection('links').model.count()).toBe(1);
    },
  );

  it('creates a source and connections with the explicit shared connection configuration', async () => {
    await configure('links', shared());
    const ctx = await context('documents', 'create', {
      values: { id: 3, name: 'Created', project: 12, projects: [12] },
    });
    expect(await run(ctx)).toEqual({ keys: [3], affected: 1 });
    expect(await row('documents', 3)).toMatchObject({ id: 3, projectId: 12, tenantId: null });
    expect(
      await external.getCollection('links').model.findAll({
        attributes: ['documentId', 'projectId'],
        where: { documentId: 3 },
        raw: true,
      }),
    ).toEqual([{ documentId: 3, projectId: 12 }]);
    expect(await row('projects', 12)).toMatchObject({ name: 'External visible', tenantId: 'H' });
    expect(await primary.getCollection('documents').model.findByPk(3)).toBeNull();
  });

  it('filters and replaces the same explicitly shared connection in one transaction', async () => {
    await configure('links', shared());
    const ctx = await context('documents', 'update', {
      filterByTk: 1,
      filter: { projects: { id: 11 } },
      values: { name: 'Edited', projects: [12] },
    });
    expect(await run(ctx)).toEqual({ keys: [1], affected: 1 });
    expect(await links()).toEqual([12]);
    expect(await row('documents', 1)).toMatchObject({ name: 'Edited', tenantId: 'B' });
  });

  it('rolls back an external child write and source values after an actual ORM hook failure', async () => {
    external.getCollection('children').model.addHook('afterUpdate', () => {
      throw new Error('external child hook failed');
    });
    const ctx = await root({ name: 'Denied', children: [11] });
    const before = await snapshot(external);
    await expect(run(ctx)).rejects.toThrow('external child hook failed');
    expect(await snapshot(external)).toEqual(before);
    expect(ctx.body).toBe('unchanged');
  });
});

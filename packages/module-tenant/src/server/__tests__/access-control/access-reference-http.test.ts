import { pathToFileURL } from 'node:url';
import { mockServer, supertest, type MockServer } from '@tachybase/test';
import { ACL, RelationField, Resourcer, Transaction, type Collection, type Context } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { AccessResourceMutationHandler } from '../../access-control/resource-mutation-handler';
import type { AccessRootReadContext } from '../../access-control/root-read-context';
import { AccessRootReadHandler } from '../../access-control/root-read-handler';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_ENTRY;
const coreResourcerEntry = process.env.TENANT_ACCESS_CORE_RESOURCER_ENTRY;
const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const coreAvailable = coreEntry || 'registerActionParamsResolver' in ACL.prototype;
const actor = { tenantId: 'B', roleName: 'editor', userId: 28 };

/** Real HTTP/ACL and PostgreSQL transactions; server fixture identities, not real authentication. */
describe.skipIf(!coreAvailable || !postgresUrl)('reference updates over real HTTP resources', () => {
  let app: MockServer;
  let acl: ACL;
  let adapter: AccessAclScopeAdapter;
  let store: AccessConfigStore;
  let unregister: (() => void) | undefined;
  let tenantScopeId: number;
  const identity = (collection: Collection) => ({
    ...mainIdentity,
    collectionName: collection.name,
    collectionKey: `${collection.name}-key`,
  });
  const identities = () =>
    ['documents', 'projects', 'document_projects', 'children', 'profiles']
      .filter((name) => app.db.collections.has(name))
      .map((name) => identity(app.db.getCollection(name)));

  beforeEach(async () => {
    // Validate the dedicated local URL before passing its options to MockServer's database factory.
    const isolated = isolatedPostgresDatabase(postgresUrl!);
    const database = isolated.options;
    await isolated.close();
    app = mockServer({ acl: false, registerActions: true, database, resourcer: { prefix: '/api' } });
    if (coreResourcerEntry) {
      // Exercise the real built core router on this fixture only, without changing installed dependencies.
      const { Resourcer: CoreResourcer } = await import(/* @vite-ignore */ pathToFileURL(coreResourcerEntry).href);
      app.resourcer.restApiMiddleware = CoreResourcer.prototype.restApiMiddleware;
    }
    const db = app.db;
    await seedConfigStore(db);
    await seedAclScopes(db);
    for (const name of ['documents', 'projects'])
      db.collection({
        name,
        timestamps: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true, autoIncrement: true },
          { name: 'tenantId', type: 'string' },
          { name: 'name', type: 'string' },
        ],
      });
    const docs = db.getCollection('documents');
    db.collection({ name: 'document_projects', timestamps: false });
    docs.setField('project', { type: 'belongsTo', target: 'projects', foreignKey: 'projectId' });
    docs.setField('projects', {
      type: 'belongsToMany',
      target: 'projects',
      through: 'document_projects',
      foreignKey: 'documentId',
      otherKey: 'projectId',
    });
    db.collection({
      name: 'tenants',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'enabled', type: 'boolean' },
      ],
    });
    await db.sync();
    await db.getCollection('tenants').model.create({ id: 'B', enabled: true });
    store = new AccessConfigStore(db, (value) =>
      resolveModelMetadata(db.getCollection(value.collectionName), {
        resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
      }),
    );
    for (const name of ['projects', 'document_projects'])
      await db.getRepository('collections').create({ values: { key: `${name}-key`, name } });
    for (const name of ['documents', 'projects']) {
      const config = configFor(ownerCondition);
      config.rules.push({
        ...configFor(
          {
            type: 'compare',
            operator: 'eq',
            left: { type: 'field', path: 'name' },
            right: { type: 'literal', value: 'Visible' },
          },
          'visibility',
        ).rules[0],
        id: 'visible',
      });
      await store.save(identity(db.getCollection(name)), { ...config, revision: 0 }, { userId: 28 });
    }
    await docs.model.bulkCreate([
      { id: 3, name: 'Owned', tenantId: 'B', projectId: null },
      { id: 4, name: 'Visible', tenantId: 'H', projectId: null },
    ]);
    await db.getCollection('projects').model.bulkCreate([
      { id: 101, name: 'Owned', tenantId: 'B' },
      { id: 102, name: 'Visible', tenantId: 'H' },
      { id: 103, name: 'Hidden', tenantId: 'C' },
    ]);
    const CoreACL = coreEntry ? (await import(/* @vite-ignore */ pathToFileURL(coreEntry).href)).ACL : ACL;
    acl = new CoreACL();
    app.mainDataSource.acl = acl;
    // Match module-acl's beforeGrantAction field normalization; do not fabricate final permissions.
    acl.beforeGrantAction((ctx) => {
      const collection = db.getCollection(ctx.resourceName);
      const fields = ctx.params.fields as string[] | undefined;
      if (!collection || !fields || !['view', 'export'].includes(acl.resolveActionAlias(ctx.actionName))) return;
      const appends = fields.filter((name) => collection.getField(name) instanceof RelationField);
      ctx.params = { ...ctx.params, fields: fields.filter((name) => !appends.includes(name)), appends };
    });
    acl.define({ role: 'editor' });
    acl.setAvailableAction('view', { aliases: ['get', 'list', 'count'] });
    acl.setAvailableAction('update', {});
    tenantScopeId = (
      await db.getRepository('dataSourcesRolesResourcesScopes').create({
        values: { key: 'tenant', dataSourceKey: 'main', scope: { tenantId: '{{ ctx.state.currentTenant.id }}' } },
      })
    ).get('id');
    await grant('documents', 'view', ['id', 'name']);
    await grant('projects', 'view', ['id', 'name']);
    await grant('documents', 'update', ['name', 'project', 'projects']);
    adapter = new AccessAclScopeAdapter(acl, 'main', store, db);
    unregister = adapter.register();
    const queries = new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection)));
    const reader = new AccessRootReadHandler(db, adapter, queries, identity);
    const writer = new AccessResourceMutationHandler(db, adapter, queries, identity);
    app.resourcer.use(
      async (ctx, next) => {
        ctx.state.currentRole = actor.roleName;
        ctx.state.currentTenant = { id: actor.tenantId };
        ctx.state.currentUser = { id: actor.userId };
        await adapter.prepare(ctx, identities());
        try {
          await next();
        } finally {
          adapter.release(ctx);
        }
      },
      { tag: 'access-reference-preparation', after: 'auth' },
    );
    app.resourcer.use(acl.middleware(), { tag: 'access-reference-acl', after: 'access-reference-preparation' });
    const execute = async (ctx: Context & { permission: unknown }, mode: 'read' | 'write') => {
      if (!('permission' in ctx)) throw new Error('ACL middleware did not finalize this request');
      const related: AccessRootReadContext[] = [];
      const authorize = async (collection: Collection, actionName: 'list' | 'update' | 'add' | 'remove' | 'set') => {
        // A separate neutral root decision, using the same persisted role grants and ACL middleware.
        // Never forward the original request's fields, filter, key or values to this decision.
        const resourcer = new Resourcer();
        resourcer.define({ name: collection.name, actions: { [actionName]: {} } });
        const action = resourcer.getAction(collection.name, actionName).clone();
        Object.assign(action, { resourceName: collection.name, actionName });
        action.mergeParams({ resourceName: collection.name, actionName, filterByTk: undefined });
        const decision = {
          db,
          action,
          permission: undefined as unknown,
          state: ctx.state,
          get: ctx.get.bind(ctx),
          logger: ctx.logger,
          throw: ctx.throw.bind(ctx),
        };
        related.push(decision);
        await adapter.prepare(decision, identities());
        await acl.middleware()(decision as never, async () => {});
        return decision;
      };
      try {
        if (mode === 'read') {
          await reader.handleResourceWithRelatedContexts(ctx, actor, (collection) => authorize(collection, 'list'));
        } else {
          await writer.handle(ctx, actor, {
            read: (collection) => authorize(collection, 'list'),
            update: (collection) => authorize(collection, 'update'),
            source: authorize,
          });
        }
      } finally {
        for (const decision of related) adapter.release(decision);
      }
    };
    for (const name of ['documents', 'projects'])
      app.resourcer.define({
        name,
        actions: Object.fromEntries(
          ['get', 'list', 'count'].map((action) => [
            action,
            (ctx: Context & { permission: unknown }) => execute(ctx, 'read'),
          ]),
        ),
      });
    for (const relation of ['project', 'projects', 'children', 'profile'])
      for (const action of ['get', 'list', 'count'])
        app.resourcer.registerActionHandler(`documents.${relation}:${action}`, (ctx) =>
          execute(ctx as Context & { permission: unknown }, 'read'),
        );
    for (const path of [
      'documents:create',
      'documents:update',
      ...['add', 'remove', 'set'].map((operation) => `documents.projects:${operation}`),
      ...['add', 'remove', 'set'].map((operation) => `documents.children:${operation}`),
      ...['remove', 'set'].map((operation) => `documents.profile:${operation}`),
    ])
      app.resourcer.registerActionHandler(path, (ctx) => execute(ctx as Context & { permission: unknown }, 'write'));
  });

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    try {
      await app?.db.sequelize.drop({ cascade: true });
    } finally {
      await app?.destroy();
    }
  });

  async function grant(
    resourceName: string,
    name: 'view' | 'create' | 'update' | 'add' | 'remove' | 'set',
    fields: string[],
    filter?: object,
  ) {
    const db = app.db;
    const scopeId = filter
      ? (
          await db.getRepository('dataSourcesRolesResourcesScopes').create({
            values: { key: `custom-${resourceName}-${name}`, dataSourceKey: 'main', scope: filter },
          })
        ).get('id')
      : tenantScopeId;
    const action = await db.getRepository('dataSourcesRolesResourcesScopesActions').create({
      values: { name, fields, scopeId },
    });
    await action.writeToACL({
      acl,
      role: acl.getRole('editor'),
      resourceName,
      associationFieldsActions: {},
      grantHelper: {},
    });
  }

  const row = async (name = 'documents', id = 3) => (await app.db.getCollection(name).model.findByPk(id))?.toJSON();
  const links = async () =>
    (await app.db.getCollection('document_projects').model.findAll({ order: [['projectId', 'ASC']] })).map((record) =>
      Number(record.get('projectId')),
    );
  const update = (values: object, id = 3) => app.agent().resource('documents').update({ filterByTk: id, values });

  /** Real second connection creates a read/write cycle after the HTTP writer has persisted its patch. */
  async function assertConcurrentFilterRollback(
    request: () => PromiseLike<{ status: number; body: unknown }>,
    nextName = 'Revoked',
    childTable?: string,
    stage: 'verification' | 'commit' = 'verification',
  ) {
    const db = app.db;
    const competitor = isolatedPostgresDatabase(postgresUrl!);
    const docs = db.getCollection('documents');
    const projects = db.getCollection('projects');
    const quote = db.sequelize.getQueryInterface().queryGenerator;
    const documentsTable = quote.quoteTable(docs.model.getTableName());
    const projectsTable = quote.quoteTable(projects.model.getTableName());
    let sourceWrites = 0;
    let notifications = 0;
    let interference = 0;
    let observedSource: unknown;
    let observedChildren: unknown;
    let commitAttempts = 0;
    let commitErrorCode: string | undefined;
    let restoreCommit: (() => void) | undefined;
    const interfere = async (transaction: Transaction) => {
      if (interference++) throw new Error('HTTP writer unexpectedly retried');
      observedSource = (await docs.model.findByPk(3, { transaction }))?.get('name');
      await competitor.sequelize.transaction(
        { isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE },
        async (changer) => {
          await competitor.sequelize.query("SET LOCAL statement_timeout = '10s'", { transaction: changer });
          const [before] = await competitor.sequelize.query(`SELECT name FROM ${documentsTable} WHERE id = 3`, {
            transaction: changer,
          });
          expect(before).toEqual([{ name: 'Owned' }]);
          await competitor.sequelize.query(`UPDATE ${projectsTable} SET name = $name WHERE id = 102`, {
            bind: { name: nextName },
            transaction: changer,
          });
        },
      );
    };
    docs.model.addHook('afterUpdate', 'http-relational-concurrency', async (_record, options) => {
      sourceWrites++;
      options.transaction.afterCommit(() => {
        notifications++;
      });
      if (stage === 'commit') {
        const transaction = options.transaction;
        const commit = transaction.commit.bind(transaction);
        const spy = vi.spyOn(transaction, 'commit').mockImplementation(async () => {
          commitAttempts++;
          await interfere(transaction);
          try {
            await commit();
          } catch (error) {
            commitErrorCode = (error as { original?: { code?: string } }).original?.code;
            throw error;
          }
        });
        restoreCommit = () => spy.mockRestore();
      } else if (!childTable) await interfere(options.transaction);
    });
    if (childTable)
      db.getCollection(childTable).model.addHook(
        'afterUpdate',
        'http-relational-concurrency',
        async (_record, options) => {
          const children = await db.getCollection(childTable).model.findAll({
            where: { id: [201, 205] },
            order: [['id', 'ASC']],
            transaction: options.transaction,
          });
          const keys = children.map((child) => child.get('documentId'));
          if (keys[0] !== 3 || keys[1] !== null) return;
          observedChildren = keys;
          if (stage === 'verification') await interfere(options.transaction);
        },
      );
    try {
      const response = await request();
      expect(response.status).toBe(409);
      expect(response.body).not.toHaveProperty('data');
      expect(sourceWrites).toBe(1);
      expect(interference).toBe(1);
      if (stage === 'commit') {
        expect(commitAttempts).toBe(1);
        expect(commitErrorCode).toBe('40001');
      }
      expect(observedSource).toBe('Changed');
      if (childTable) expect(observedChildren).toEqual([3, null]);
      expect(notifications).toBe(0);
      expect(await row()).toMatchObject({ name: 'Owned', tenantId: 'B', projectId: 102 });
      expect((await row('projects', 102)).name).toBe(nextName);
    } finally {
      docs.model.removeHook('afterUpdate', 'http-relational-concurrency');
      restoreCommit?.();
      if (childTable) db.getCollection(childTable).model.removeHook('afterUpdate', 'http-relational-concurrency');
      await competitor.close();
    }
  }
  async function grantLink(operation: 'add' | 'remove' | 'set') {
    acl.setAvailableAction(operation, {});
    await grant('documents', operation, ['projects']);
    await grant('projects', operation, ['id']);
  }
  const link = (operation: 'add' | 'remove' | 'set', values: number[], source: string | number = 3) =>
    supertest(app.callback()).post(`/api/documents/${source}/projects:${operation}`).send(values);
  const seedLinks = (ids: number[], source = 3) =>
    app.db
      .getCollection('document_projects')
      .model.bulkCreate(ids.map((projectId) => ({ documentId: source, projectId })));

  it('applies a nonempty scalar filter through the actual root update HTTP route', async () => {
    const response = await supertest(app.callback())
      .post('/api/documents:update')
      .query({ filterByTk: 3, filter: JSON.stringify({ name: { $startsWith: 'Own' } }) })
      .send({ name: 'Changed' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
    expect(await row()).toMatchObject({ name: 'Changed', tenantId: 'B' });
  });

  it.each(['keyed', 'matching'])('updates ordinary fields using a %s relational HTTP filter', async (selection) => {
    await grant('documents', 'view', ['id', 'name', 'project']);
    await app.db.getCollection('documents').model.update({ projectId: 102 }, { where: { id: [3, 4] } });
    const response = await supertest(app.callback())
      .post('/api/documents:update')
      .query({
        ...(selection === 'keyed' ? { filterByTk: 3 } : {}),
        filter: JSON.stringify({ project: { name: 'Visible' } }),
      })
      .send({ name: 'Changed' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
    expect(await row()).toMatchObject({ name: 'Changed', tenantId: 'B', projectId: 102 });
    expect(await row('documents', 4)).toMatchObject({ name: 'Visible', tenantId: 'H' });
    expect(await row('projects', 102)).toMatchObject({ name: 'Visible', tenantId: 'H' });
  });

  describe('concurrent relational-filtered HTTP writes', () => {
    beforeEach(async () => {
      await grant('documents', 'view', ['id', 'name', 'project']);
      await app.db.getCollection('documents').model.update({ projectId: 102 }, { where: { id: 3 } });
    });

    it.each(['keyed', 'matching', 'project', 'projects', 'mixed'])(
      'preserves the real COMMIT failure on a %s update',
      async (kind) => {
        await assertConcurrentFilterRollback(
          () =>
            supertest(app.callback())
              .post('/api/documents:update')
              .query({
                ...(kind === 'matching' ? {} : { filterByTk: 3 }),
                filter: JSON.stringify({ project: { name: 'Visible' } }),
              })
              .send({
                name: 'Changed',
                ...(['project', 'mixed'].includes(kind) ? { project: 101 } : {}),
                ...(['projects', 'mixed'].includes(kind) ? { projects: [101] } : {}),
              }),
          'Revoked',
          undefined,
          'commit',
        );
        expect(await links()).toEqual([]);
        expect(await row('projects', 101)).toEqual({ id: 101, name: 'Owned', tenantId: 'B' });
      },
    );

    it.each(['keyed', 'matching'])(
      'preserves the real COMMIT failure on a %s negated-existence update',
      async (kind) => {
        await app.db.getCollection('projects').model.update({ name: 'Hidden' }, { where: { id: 102 } });
        await assertConcurrentFilterRollback(
          () =>
            supertest(app.callback())
              .post('/api/documents:update')
              .query({
                ...(kind === 'matching' ? {} : { filterByTk: 3 }),
                filter: JSON.stringify({ 'project.$notExists': true }),
              })
              .send({ name: 'Changed' }),
          'Visible',
          undefined,
          'commit',
        );
      },
    );

    it.each(['keyed', 'matching'])('rolls back a %s update after concurrent filter revocation', async (mode) => {
      await assertConcurrentFilterRollback(() =>
        supertest(app.callback())
          .post('/api/documents:update')
          .query({
            ...(mode === 'keyed' ? { filterByTk: 3 } : {}),
            filter: JSON.stringify({ project: { name: 'Visible' } }),
          })
          .send({ name: 'Changed' }),
      );
    });

    it.each(['keyed', 'matching'])(
      'rolls back a %s negated-existence update after a concurrent grant',
      async (mode) => {
        await app.db.getCollection('projects').model.update({ name: 'Hidden' }, { where: { id: 102 } });
        await assertConcurrentFilterRollback(
          () =>
            supertest(app.callback())
              .post('/api/documents:update')
              .query({
                ...(mode === 'keyed' ? { filterByTk: 3 } : {}),
                filter: JSON.stringify({ 'project.$notExists': true }),
              })
              .send({ name: 'Changed' }),
          'Visible',
        );
      },
    );

    it.each(['project', 'projects', 'mixed'])(
      'rolls back %s assignments after concurrent filter revocation',
      async (kind) => {
        await assertConcurrentFilterRollback(() =>
          supertest(app.callback())
            .post('/api/documents:update')
            .query({ filterByTk: 3, filter: JSON.stringify({ project: { name: 'Visible' } }) })
            .send({
              name: 'Changed',
              ...(kind === 'projects' ? {} : { project: 101 }),
              ...(kind === 'project' ? {} : { projects: [101] }),
            }),
        );
        expect(await links()).toEqual([]);
        expect(await row('projects', 101)).toEqual({ id: 101, name: 'Owned', tenantId: 'B' });
      },
    );

    it.each(['scalar', 'project', 'projects', 'mixed'])(
      'rejects a %s request started after revocation committed',
      async (kind) => {
        await app.db.getCollection('projects').model.update({ name: 'Revoked' }, { where: { id: 102 } });
        const response = await supertest(app.callback())
          .post('/api/documents:update')
          .query({ filterByTk: 3, filter: JSON.stringify({ project: { name: 'Visible' } }) })
          .send({
            name: 'Changed',
            ...(['project', 'mixed'].includes(kind) ? { project: 101 } : {}),
            ...(['projects', 'mixed'].includes(kind) ? { projects: [101] } : {}),
          });
        expect(response.status).toBe(403);
        expect(await row()).toMatchObject({ name: 'Owned', tenantId: 'B', projectId: 102 });
        expect(await links()).toEqual([]);
      },
    );

    it('allows a legal serial order when the concurrent changer does not read the source', async () => {
      const db = app.db;
      const competitor = isolatedPostgresDatabase(postgresUrl!);
      const table = db.sequelize
        .getQueryInterface()
        .queryGenerator.quoteTable(db.getCollection('projects').model.getTableName());
      let writes = 0;
      let notifications = 0;
      db.getCollection('documents').model.addHook(
        'afterUpdate',
        'legal-http-interleaving',
        async (_record, options) => {
          writes++;
          options.transaction.afterCommit(() => {
            notifications++;
          });
          await competitor.sequelize.transaction(
            { isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE },
            async (transaction) => {
              await competitor.sequelize.query(`UPDATE ${table} SET name = 'Revoked' WHERE id = 102`, { transaction });
            },
          );
        },
      );
      try {
        const response = await supertest(app.callback())
          .post('/api/documents:update')
          .query({ filterByTk: 3, filter: JSON.stringify({ project: { name: 'Visible' } }) })
          .send({ name: 'Changed' });
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
        expect(await row()).toMatchObject({ name: 'Changed', tenantId: 'B', projectId: 102 });
        expect((await row('projects', 102)).name).toBe('Revoked');
        expect(writes).toBe(1);
        expect(notifications).toBe(1);
      } finally {
        db.getCollection('documents').model.removeHook('afterUpdate', 'legal-http-interleaving');
        await competitor.close();
      }
    });
  });

  describe('relational-filtered ordinary HTTP writes', () => {
    beforeEach(async () => {
      await grant('documents', 'view', ['id', 'name', 'project']);
      await app.db.getCollection('documents').model.update({ projectId: 102 }, { where: { id: [3, 4] } });
    });
    const filtered = (filter: object = { project: { name: 'Visible' } }, key: number | null = 3) =>
      supertest(app.callback())
        .post('/api/documents:update')
        .query({ ...(key === null ? {} : { filterByTk: key }), filter: JSON.stringify(filter) })
        .send({ name: 'Changed' });

    it.each([
      'source-field',
      'target-field',
      'target-operation',
      'target-role',
      'source-read-role',
      'source-write-role',
      'ownership',
      'request',
      'target-visibility',
    ])('retains the %s boundary', async (boundary) => {
      if (boundary === 'source-field') await grant('documents', 'view', ['id', 'name']);
      if (boundary === 'target-field') await grant('projects', 'view', ['id']);
      if (boundary === 'target-operation') acl.getRole('editor').revokeAction('projects:view');
      if (boundary === 'target-role') await grant('projects', 'view', ['id', 'name'], { name: 'Other' });
      if (boundary === 'source-read-role')
        await grant('documents', 'view', ['id', 'name', 'project'], { name: 'Other' });
      if (boundary === 'source-write-role') await grant('documents', 'update', ['name'], { name: 'Other' });
      if (boundary === 'target-visibility')
        await app.db.getCollection('documents').model.update({ projectId: 103 }, { where: { id: 3 } });
      const response = await filtered(
        {
          project: { name: boundary === 'request' ? 'Other' : boundary === 'target-visibility' ? 'Hidden' : 'Visible' },
        },
        boundary === 'ownership' ? 4 : 3,
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.body).not.toHaveProperty('data');
      expect(await row()).toMatchObject({ name: 'Owned', tenantId: 'B' });
      expect(await row('documents', 4)).toMatchObject({ name: 'Visible', tenantId: 'H' });
    });

    it.each(['keyed', 'matching'])(
      'interprets hidden targets as absent for a %s negative filter',
      async (selection) => {
        await app.db.getCollection('documents').model.update({ projectId: 103 }, { where: { id: 3 } });
        const response = await filtered({ 'project.$notExists': true }, selection === 'keyed' ? 3 : null);
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
        expect(await row()).toMatchObject({ name: 'Changed', projectId: 103, tenantId: 'B' });
        expect(await row('projects', 103)).toMatchObject({ name: 'Hidden', tenantId: 'C' });
      },
    );

    it('does not fall back from explicit keys whose member misses the relational condition', async () => {
      await app.db.getCollection('documents').model.create({ id: 7, name: 'Other', tenantId: 'B', projectId: 101 });
      const response = await supertest(app.callback())
        .post('/api/documents:update')
        .query({ 'filterByTk[]': [3, 7], filter: JSON.stringify({ project: { name: 'Visible' } }) })
        .send({ name: 'Changed' });
      expect(response.status).toBe(403);
      expect(response.body).not.toHaveProperty('data');
      expect(await row()).toMatchObject({ name: 'Owned' });
      expect(await row('documents', 7)).toMatchObject({ name: 'Other' });
    });

    it('returns an empty result for a matching selection with no readable target', async () => {
      await app.db.getCollection('documents').model.update({ projectId: 103 }, { where: { id: 3 } });
      const response = await filtered({ project: { name: 'Hidden' } }, null);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: { keys: [], affected: 0 } });
      expect(await row()).toMatchObject({ name: 'Owned', projectId: 103 });
    });

    it('honors a source permission that permits only a nested target id', async () => {
      await grant('documents', 'view', ['id', 'name']);
      acl.addFixedParams('documents', 'list', () => ({ appends: ['project.id'] }));
      const response = await filtered();
      expect(response.status).toBe(400);
      expect(response.body).not.toHaveProperty('data');
      expect(await row()).toMatchObject({ name: 'Owned' });
      const allowed = await filtered({ project: { id: 102 } });
      expect(allowed.status).toBe(200);
      expect(allowed.body).toEqual({ data: { keys: [3], affected: 1 } });
      expect(await row()).toMatchObject({ name: 'Changed' });
    });

    it('commits even when the edited source exits its former request and role ranges', async () => {
      await grant('documents', 'view', ['id', 'name', 'project'], { name: 'Owned' });
      await grant('documents', 'update', ['name'], { name: 'Owned' });
      const response = await filtered({ name: 'Owned', project: { name: 'Visible' } });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
      expect(await row()).toMatchObject({ name: 'Changed', tenantId: 'B' });
    });

    it('keeps read-only legacy sources unchanged', async () => {
      await app.db.getCollection('documents').model.update({ tenantId: null, name: 'Visible' }, { where: { id: 3 } });
      const response = await filtered();
      expect(response.status).toBe(403);
      expect(await row()).toMatchObject({ name: 'Visible', tenantId: null });
    });

    it('claims an editable historical source without claiming its filter target', async () => {
      const source = identity(app.db.getCollection('documents'));
      const saved = (await store.read(source))!;
      await store.save(
        source,
        { ...configFor({ type: 'constant', value: true }), revision: saved.revision },
        { userId: 28 },
      );
      await app.db.getCollection('documents').model.update({ tenantId: null }, { where: { id: 3 } });
      const response = await filtered();
      expect(response.status).toBe(200);
      expect(await row()).toMatchObject({ name: 'Changed', tenantId: 'B' });
      expect(await row('projects', 102)).toMatchObject({ name: 'Visible', tenantId: 'H' });
    });

    it('rolls back all selected sources after a later repository failure', async () => {
      await app.db.getCollection('documents').model.create({ id: 7, name: 'Owned', tenantId: 'B', projectId: 102 });
      let observed = false;
      app.db.on('documents.afterUpdate', async (record, options) => {
        if (record.get('id') !== 7) return;
        const first = await app.db.getCollection('documents').model.findByPk(3, { transaction: options.transaction });
        expect(first?.get('name')).toBe('Changed');
        expect(options.transaction.options.isolationLevel).toBe('SERIALIZABLE');
        observed = true;
        throw new Error('Late relational selection failure');
      });
      const response = await filtered({ project: { name: 'Visible' } }, null);
      expect(response.status).toBe(500);
      expect(observed).toBe(true);
      expect(response.body).not.toHaveProperty('data');
      expect(await row()).toMatchObject({ name: 'Owned' });
      expect(await row('documents', 7)).toMatchObject({ name: 'Owned' });
    });

    it('rolls back when participating target metadata changes after persistence', async () => {
      const attribute = app.db.getCollection('projects').model.rawAttributes.name;
      const field = attribute.field;
      app.db.on('documents.afterUpdate', () => {
        attribute.field = 'changed_name';
      });
      try {
        const response = await filtered();
        expect(response.status).toBe(400);
        expect(response.body).not.toHaveProperty('data');
      } finally {
        attribute.field = field;
      }
      expect(await row()).toMatchObject({ name: 'Owned' });
    });

    describe('many-to-many selection', () => {
      beforeEach(async () => {
        const through = app.db.getCollection('document_projects');
        await store.save(
          identity(through),
          { ...configFor({ type: 'constant', value: true }), ownership: { enabled: false }, revision: 0 },
          { userId: 28 },
        );
        await grant('documents', 'view', ['id', 'name', 'projects']);
        await grant('document_projects', 'view', ['documentId', 'projectId']);
        await seedLinks([101, 102]);
      });
      it('updates each root once despite duplicate matching targets', async () => {
        const response = await filtered({ 'projects.id': { $in: [101, 102] } });
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
        expect(await row()).toMatchObject({ name: 'Changed', tenantId: 'B' });
        expect(await links()).toEqual([101, 102]);
      });
      it('requires the through table list operation', async () => {
        acl.getRole('editor').revokeAction('document_projects:view');
        const response = await filtered({ 'projects.id': 102 });
        expect(response.status).toBe(403);
        expect(await row()).toMatchObject({ name: 'Owned' });
        expect(await links()).toEqual([101, 102]);
      });
      it('honors the independent through row role scope', async () => {
        await grant('document_projects', 'view', ['documentId', 'projectId'], { projectId: 101 });
        const response = await filtered({ 'projects.id': 102 });
        expect(response.status).toBe(403);
        expect(await row()).toMatchObject({ name: 'Owned' });
        expect(await links()).toEqual([101, 102]);
      });
      it('honors through table access rules independently of its role scope', async () => {
        const source = identity(app.db.getCollection('document_projects'));
        const saved = (await store.read(source))!;
        await store.save(
          source,
          { ...configFor({ type: 'constant', value: false }), ownership: { enabled: false }, revision: saved.revision },
          { userId: 28 },
        );
        const response = await filtered({ 'projects.id': 102 });
        expect(response.status).toBe(403);
        expect(await row()).toMatchObject({ name: 'Owned' });
        expect(await links()).toEqual([101, 102]);
      });
    });

    describe.each(['HasMany', 'HasOne'])('%s filter targets', (kind) => {
      const name = kind === 'HasMany' ? 'children' : 'profiles';
      beforeEach(async () => {
        const target = app.db.collection({
          name,
          timestamps: false,
          fields: [
            { name: 'id', type: 'integer', primaryKey: true },
            { name: 'tenantId', type: 'string' },
            { name: 'documentId', type: 'integer' },
            { name: 'name', type: 'string' },
          ],
        });
        app.db.getCollection('documents').setField(name, {
          type: kind === 'HasMany' ? 'hasMany' : 'hasOne',
          target: name,
          foreignKey: 'documentId',
          onDelete: 'RESTRICT',
        });
        await target.model.sync();
        await app.db.getRepository('collections').create({ values: { key: `${name}-key`, name } });
        const config = configFor(ownerCondition);
        config.rules.push({
          ...configFor(
            {
              type: 'compare',
              operator: 'eq',
              left: { type: 'field', path: 'name' },
              right: { type: 'literal', value: 'Visible' },
            },
            'visibility',
          ).rules[0],
          id: 'visible',
        });
        await store.save(identity(target), { ...config, revision: 0 }, { userId: 28 });
        await target.model.create({ id: 201, tenantId: 'B', documentId: 3, name: 'Owned' });
        await grant('documents', 'view', ['id', 'name', name]);
        await grant(name, 'view', ['id', 'name']);
      });
      it.each(['keyed', 'matching'])('uses readable children without writing them for %s roots', async (selection) => {
        const response = await filtered({ [name]: { name: 'Owned' } }, selection === 'keyed' ? 3 : null);
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
        expect(await row()).toMatchObject({ name: 'Changed', tenantId: 'B' });
        expect(await row(name, 201)).toMatchObject({ name: 'Owned', tenantId: 'B', documentId: 3 });
      });
      it('uses a visible historical child without claiming it', async () => {
        await app.db.getCollection(name).model.update({ tenantId: null, name: 'Visible' }, { where: { id: 201 } });
        const response = await filtered({ [name]: { name: 'Visible' } });
        expect(response.status).toBe(200);
        expect(await row(name, 201)).toMatchObject({ name: 'Visible', tenantId: null, documentId: 3 });
      });
      it('keeps target role conditions independent of source permissions', async () => {
        await grant(name, 'view', ['id', 'name'], { name: 'Missing' });
        const response = await filtered({ [name]: { name: 'Owned' } });
        expect(response.status).toBe(403);
        expect(await row()).toMatchObject({ name: 'Owned' });
      });
    });
  });

  it.each(['request', 'field', 'read-scope', 'ownership'])(
    'preserves the %s boundary on filtered HTTP updates',
    async (boundary) => {
      if (boundary === 'field') await grant('documents', 'view', ['id']);
      if (boundary === 'read-scope') await grant('documents', 'view', ['id', 'name'], { name: 'Other' });
      const id = boundary === 'ownership' ? 4 : 3;
      const name = boundary === 'ownership' ? 'Visible' : boundary === 'request' ? 'Other' : 'Owned';
      const response = await supertest(app.callback())
        .post('/api/documents:update')
        .query({ filterByTk: id, filter: JSON.stringify({ name }) })
        .send({ name: 'Forbidden' });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await row()).toMatchObject({ name: 'Owned', tenantId: 'B' });
      expect(await row('documents', 4)).toMatchObject({ name: 'Visible', tenantId: 'H' });
    },
  );

  describe('scalar-filtered root reference updates', () => {
    const filteredUpdate = (values: object, filter: object = { name: 'Owned' }, id = 3) =>
      supertest(app.callback())
        .post('/api/documents:update')
        .query({ filterByTk: id, filter: JSON.stringify(filter) })
        .send(values);

    it.each([
      { kind: 'single', values: { project: 102, name: 'Changed' }, projectId: 102, projectIds: [] },
      { kind: 'multiple', values: { projects: [102], name: 'Changed' }, projectId: null, projectIds: [102] },
      {
        kind: 'mixed',
        values: { project: 102, projects: [101, 102], name: 'Changed' },
        projectId: 102,
        projectIds: [101, 102],
      },
    ])(
      'preserves source selection when updating $kind references and scalar values',
      async ({ values, projectId, projectIds }) => {
        const response = await supertest(app.callback())
          .post('/api/documents:update')
          .query({ filterByTk: 3, filter: JSON.stringify({ name: { $startsWith: 'Own' } }) })
          .send(values);
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
        expect(await row()).toMatchObject({ name: 'Changed', projectId, tenantId: 'B' });
        expect(await links()).toEqual(projectIds);
        expect(await row('projects', 102)).toMatchObject({ name: 'Visible', tenantId: 'H' });
      },
    );

    it.each(['project', 'projects'])('retains or replaces existing links on a filtered %s update', async (name) => {
      await seedLinks([101]);
      const response = await filteredUpdate({ [name]: name === 'project' ? 102 : [102], name: 'Changed' });
      expect(response.status).toBe(200);
      expect(await row()).toMatchObject({ name: 'Changed', tenantId: 'B' });
      expect(await links()).toEqual(name === 'projects' ? [102] : [101]);
    });

    it.each(
      ['project', 'projects'].flatMap((name) =>
        [
          'request',
          'read-scope',
          'field',
          'write-scope',
          'ownership',
          'hidden-target',
          'target-field',
          'target-scope',
          'write-field',
        ].map((boundary) => ({ name, boundary })),
      ),
    )('rejects $boundary without changing source or links on a filtered $name update', async ({ name, boundary }) => {
      await seedLinks([101]);
      if (boundary === 'read-scope') await grant('documents', 'view', ['id', 'name'], { name: 'Other' });
      if (boundary === 'field') await grant('documents', 'view', ['id']);
      if (boundary === 'write-scope') await grant('documents', 'update', ['name', name], { name: 'Other' });
      if (boundary === 'write-field') await grant('documents', 'update', ['name']);
      if (boundary === 'target-field') await grant('projects', 'view', ['name']);
      if (boundary === 'target-scope') await grant('projects', 'view', ['id', 'name'], { name: 'Other' });
      const targetId = boundary === 'hidden-target' ? 103 : 102;
      const id = boundary === 'ownership' ? 4 : 3;
      const filter = { name: boundary === 'ownership' ? 'Visible' : boundary === 'request' ? 'Other' : 'Owned' };
      const response = await filteredUpdate(
        { [name]: name === 'project' ? targetId : [targetId], name: 'Forbidden' },
        filter,
        id,
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.body).not.toHaveProperty('data');
      expect(await row()).toMatchObject({ name: 'Owned', tenantId: 'B', projectId: null });
      expect(await row('documents', 4)).toMatchObject({ name: 'Visible', tenantId: 'H', projectId: null });
      expect(await links()).toEqual([101]);
    });

    it.each(['project', 'projects'])('clears a filtered %s without requiring old target access', async (name) => {
      await app.db.getCollection('documents').model.update({ projectId: 103 }, { where: { id: 3 } });
      await seedLinks([103]);
      await grant('projects', 'view', ['name'], { name: 'Other' });
      const response = await filteredUpdate({ [name]: name === 'project' ? null : [], name: 'Changed' });
      expect(response.status).toBe(200);
      expect(await row()).toMatchObject({ name: 'Changed', projectId: name === 'project' ? null : 103 });
      expect(await links()).toEqual(name === 'projects' ? [] : [103]);
      expect(await row('projects', 103)).toMatchObject({ name: 'Hidden', tenantId: 'C' });
    });

    it('treats template markers in a filtered reference update as literal request text', async () => {
      await app.db.getCollection('documents').model.update({ name: '{{ project name }}' }, { where: { id: 3 } });
      const response = await filteredUpdate({ project: 102, name: 'Changed' }, { name: '{{ project name }}' });
      expect(response.status).toBe(200);
      expect(await row()).toMatchObject({ name: 'Changed', projectId: 102 });
    });

    it('rolls back source fields, references and links on a late filtered join failure', async () => {
      await seedLinks([101]);
      let observed: unknown;
      app.db.getCollection('document_projects').model.addHook('afterBulkCreate', async (_records, options) => {
        observed = {
          source: (
            await app.db.getCollection('documents').model.findByPk(3, { transaction: options.transaction })
          )?.toJSON(),
          links: (
            await app.db.getCollection('document_projects').model.findAll({ transaction: options.transaction })
          ).map((record) => Number(record.get('projectId'))),
        };
        throw new Error('filtered join rollback fixture');
      });
      const response = await filteredUpdate({ project: 102, projects: [102], name: 'Forbidden' });
      expect(response.status).toBe(500);
      expect(response.body).not.toHaveProperty('data');
      expect(observed).toEqual({ source: { id: 3, name: 'Forbidden', tenantId: 'B', projectId: 102 }, links: [102] });
      expect(await row()).toMatchObject({ name: 'Owned', tenantId: 'B', projectId: null });
      expect(await links()).toEqual([101]);
    });
  });

  describe('relational-filtered root reference updates', () => {
    beforeEach(async () => {
      await grant('documents', 'view', ['id', 'name', 'project']);
      await app.db.getCollection('documents').model.update({ projectId: 101 }, { where: { id: [3, 4] } });
      await seedLinks([101]);
    });
    const filtered = (values: object, filter: object = { project: { name: 'Owned' } }, id = 3) =>
      supertest(app.callback())
        .post('/api/documents:update')
        .query({ filterByTk: id, filter: JSON.stringify(filter) })
        .send(values);

    it.each([
      { kind: 'single', values: { project: 102, name: 'Changed' }, projectId: 102, projectIds: [101] },
      { kind: 'multiple', values: { projects: [102], name: 'Changed' }, projectId: 101, projectIds: [102] },
      { kind: 'mixed', values: { project: 102, projects: [102], name: 'Changed' }, projectId: 102, projectIds: [102] },
    ])('retains pre-write selection for $kind references', async ({ values, projectId, projectIds }) => {
      const response = await filtered(values);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
      expect(await row()).toMatchObject({ name: 'Changed', projectId, tenantId: 'B' });
      expect(await links()).toEqual(projectIds);
      expect(await row('projects', 101)).toMatchObject({ name: 'Owned', tenantId: 'B' });
      expect(await row('projects', 102)).toMatchObject({ name: 'Visible', tenantId: 'H' });
    });

    it.each(
      ['project', 'projects'].flatMap((name) =>
        [
          'request',
          'source-read-field',
          'source-read-role',
          'source-write-role',
          'source-write-field',
          'source-ownership',
          'filter-target-hidden',
          'new-target-hidden',
          'new-target-field',
          'new-target-role',
        ].map((boundary) => ({ name, boundary })),
      ),
    )('retains $boundary for $name writes', async ({ name, boundary }) => {
      if (boundary === 'source-read-field') await grant('documents', 'view', ['id', 'name']);
      if (boundary === 'source-read-role')
        await grant('documents', 'view', ['id', 'name', 'project'], { name: 'Other' });
      if (boundary === 'source-write-role')
        await grant('documents', 'update', ['name', 'project', 'projects'], { name: 'Other' });
      if (boundary === 'source-write-field') await grant('documents', 'update', ['name']);
      if (boundary === 'new-target-field') await grant('projects', 'view', ['name']);
      if (boundary === 'new-target-role') await grant('projects', 'view', ['id', 'name'], { id: 101 });
      if (boundary === 'filter-target-hidden')
        await app.db.getCollection('documents').model.update({ projectId: 103 }, { where: { id: 3 } });
      const selected = boundary === 'new-target-hidden' ? 103 : 102;
      const response = await filtered(
        { [name]: name === 'project' ? selected : [selected], name: 'Forbidden' },
        {
          project: {
            name: boundary === 'request' ? 'Other' : boundary === 'filter-target-hidden' ? 'Hidden' : 'Owned',
          },
        },
        boundary === 'source-ownership' ? 4 : 3,
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.body).not.toHaveProperty('data');
      expect(await row()).toMatchObject({
        name: 'Owned',
        tenantId: 'B',
        projectId: boundary === 'filter-target-hidden' ? 103 : 101,
      });
      expect(await row('documents', 4)).toMatchObject({ name: 'Visible', tenantId: 'H', projectId: 101 });
      expect(await links()).toEqual([101]);
    });

    const legacySource = async () => {
      const source = identity(app.db.getCollection('documents'));
      const current = (await store.read(source))!;
      await store.save(
        source,
        { ...configFor({ type: 'constant', value: true }), revision: current.revision },
        { userId: 28 },
      );
      await app.db.getCollection('documents').model.update({ tenantId: null }, { where: { id: 3 } });
    };
    it.each(['project', 'projects'])(
      'does not claim a historical source for an unchanged %s selection',
      async (name) => {
        await legacySource();
        const response = await filtered({ [name]: name === 'project' ? 101 : [101] });
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ data: { keys: [], affected: 0 } });
        expect(await row()).toMatchObject({ name: 'Owned', tenantId: null, projectId: 101 });
        expect(await links()).toEqual([101]);
      },
    );
    it.each(['project', 'projects'])('claims only the edited historical source for a changed %s', async (name) => {
      await legacySource();
      await app.db.getCollection('projects').model.update({ tenantId: null }, { where: { id: 102 } });
      const response = await filtered({ [name]: name === 'project' ? 102 : [102] });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
      expect(await row()).toMatchObject({ name: 'Owned', tenantId: 'B', projectId: name === 'project' ? 102 : 101 });
      expect(await links()).toEqual(name === 'project' ? [101] : [102]);
      expect(await row('projects', 102)).toMatchObject({ name: 'Visible', tenantId: null });
    });

    it.each(['project', 'projects'])('clears hidden %s references without separately reading them', async (name) => {
      const source = app.db.getCollection('documents');
      source.setField('filterProject', { type: 'belongsTo', target: 'projects', foreignKey: 'filterProjectId' });
      await source.model.sync({ alter: { drop: false } });
      await source.model.update({ filterProjectId: 101, projectId: 103 }, { where: { id: 3 } });
      await app.db.getCollection('document_projects').model.destroy({ where: { documentId: 3 } });
      await seedLinks([103]);
      await grant('documents', 'view', ['id', 'name', 'filterProject']);
      await grant('projects', 'view', ['name']);
      const response = await filtered({ [name]: name === 'project' ? null : [] }, { filterProject: { name: 'Owned' } });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
      expect(await row()).toMatchObject({
        tenantId: 'B',
        projectId: name === 'project' ? null : 103,
        filterProjectId: 101,
      });
      expect(await links()).toEqual(name === 'project' ? [103] : []);
      expect(await row('projects', 103)).toMatchObject({ name: 'Hidden', tenantId: 'C' });
    });

    it('rolls back scalar edits, references and links after a late join failure', async () => {
      let observed: unknown;
      app.db.getCollection('document_projects').model.addHook('afterBulkCreate', async (_records, options) => {
        observed = {
          source: (
            await app.db.getCollection('documents').model.findByPk(3, { transaction: options.transaction })
          )?.toJSON(),
          links: (
            await app.db.getCollection('document_projects').model.findAll({ transaction: options.transaction })
          ).map((record) => Number(record.get('projectId'))),
        };
        expect(options.transaction.options.isolationLevel).toBe('SERIALIZABLE');
        throw new Error('relational reference rollback fixture');
      });
      const response = await filtered({ project: 102, projects: [102], name: 'Forbidden' });
      expect(response.status).toBe(500);
      expect(response.body).not.toHaveProperty('data');
      expect(observed).toEqual({ source: { id: 3, name: 'Forbidden', tenantId: 'B', projectId: 102 }, links: [102] });
      expect(await row()).toMatchObject({ name: 'Owned', projectId: 101, tenantId: 'B' });
      expect(await links()).toEqual([101]);
    });

    it.each(['project', 'projects'])(
      'retains the relational filter metadata guard after %s persistence',
      async (name) => {
        const attribute = app.db.getCollection('projects').model.rawAttributes.name;
        const original = attribute.field;
        let observed = false;
        app.db.on('documents.afterUpdate', () => {
          observed = true;
          attribute.field = 'changed_name';
        });
        try {
          const response = await filtered({ [name]: name === 'project' ? 102 : [102], name: 'Changed' });
          expect(response.status).toBe(400);
          expect(response.body).not.toHaveProperty('data');
          expect(observed).toBe(true);
        } finally {
          attribute.field = original;
        }
        expect(await row()).toMatchObject({ name: 'Owned', projectId: 101, tenantId: 'B' });
        expect(await links()).toEqual([101]);
      },
    );

    it('keeps configured business join tables protected when filtering the relation being assigned', async () => {
      const through = identity(app.db.getCollection('document_projects'));
      await store.save(
        through,
        { ...configFor({ type: 'constant', value: true }), ownership: { enabled: false }, revision: 0 },
        { userId: 28 },
      );
      await grant('documents', 'view', ['id', 'name', 'projects']);
      await grant('document_projects', 'view', ['documentId', 'projectId']);
      const response = await filtered({ projects: [102] }, { projects: { name: 'Owned' } });
      expect(response.status).toBe(400);
      expect(response.body).not.toHaveProperty('data');
      expect(await links()).toEqual([101]);
      expect(await row()).toMatchObject({ name: 'Owned', projectId: 101 });
    });
  });

  describe('association reads', () => {
    const concrete = (relation: string, action: string, source: number | string = 3, query: object = {}) =>
      supertest(app.callback()).get(`/api/documents/${source}/${relation}:${action}`).query(query);
    const configureLinks = async (readable: boolean) => {
      const key = identity(app.db.getCollection('document_projects'));
      const current = (await store.read(key))!;
      await store.save(
        key,
        {
          ...configFor({ type: 'constant', value: readable }),
          ownership: { enabled: false },
          revision: current.revision,
        },
        { userId: 28 },
      );
    };
    beforeEach(async () => {
      await grant('documents', 'view', ['id', 'name', 'project', 'projects']);
      await grant('document_projects', 'view', ['documentId', 'projectId']);
      await store.save(
        identity(app.db.getCollection('document_projects')),
        { ...configFor({ type: 'constant', value: true }), ownership: { enabled: false }, revision: 0 },
        { userId: 28 },
      );
      await app.db.getCollection('documents').model.update({ projectId: 101 }, { where: { id: 3 } });
      await app.db.getCollection('documents').model.update({ projectId: 103 }, { where: { id: 4 } });
      await seedLinks([101, 102, 103]);
    });

    it('expands readable references while retaining roots with hidden references', async () => {
      const response = await app
        .agent()
        .resource('documents')
        .list({
          fields: ['id', 'project.name', 'projects.id'],
          sort: ['id'],
        });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        data: [
          { id: 3, project: { name: 'Owned' }, projects: [{ id: 101 }, { id: 102 }] },
          { id: 4, project: null, projects: [] },
        ],
        meta: { count: 2, page: 1, pageSize: 20, totalPage: 1 },
      });
    });

    it('filters concrete many-to-many lists by target visibility', async () => {
      const response = await supertest(app.callback())
        .get('/api/documents/3/projects:list')
        .query({ 'fields[]': ['id'], sort: 'id' });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        data: [{ id: 101 }, { id: 102 }],
        meta: { count: 2, page: 1, pageSize: 20, totalPage: 1 },
      });
    });

    it('treats the placeholder as direct target access without source or through permission', async () => {
      acl.getRole('editor').revokeAction('documents:view');
      acl.getRole('editor').revokeAction('document_projects:view');
      const response = await supertest(app.callback())
        .get('/api/documents/_/projects:get')
        .query({ filterByTk: 102, 'fields[]': ['id'] });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: { id: 102 } });
    });

    it('uses the same readable relation set for filtering lists and counts', async () => {
      const filter = { projects: { name: 'Visible' } };
      const list = await app
        .agent()
        .resource('documents')
        .list({ fields: ['id'], filter });
      const count = await app.agent().resource('documents').count({ filter });
      expect(list.status).toBe(200);
      expect(list.body.data).toEqual([{ id: 3 }]);
      expect(list.body.meta.count).toBe(1);
      expect(count.status).toBe(200);
      expect(count.body).toEqual({ data: 1 });
    });

    it.each([101, 102, 103])('gets concrete linked target %s only when readable', async (id) => {
      const response = await concrete('projects', 'get', 3, { filterByTk: id, 'fields[]': ['id'] });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: id === 103 ? null : { id } });
    });

    it.each([3, 4])('reads a single reference from source %s without losing the readable source', async (id) => {
      const response = await concrete('project', 'get', id, { 'fields[]': ['id'] });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: id === 3 ? { id: 101 } : null });
      const source = await app
        .agent()
        .resource('documents')
        .get({ filterByTk: id, fields: ['id'] });
      expect(source.status).toBe(200);
      expect(source.body).toEqual({ data: { id } });
    });

    it('does not reveal an unlinked readable target', async () => {
      const response = await concrete('projects', 'get', 4, { filterByTk: 101, 'fields[]': ['id'] });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: null });
    });

    it('retains the actual target role filter for concrete and placeholder requests', async () => {
      await grant('projects', 'view', ['id', 'name'], { id: 101 });
      const linked = await concrete('projects', 'list', 3, { 'fields[]': ['id'] });
      expect(linked.status).toBe(200);
      expect(linked.body.data).toEqual([{ id: 101 }]);
      expect(linked.body.meta.count).toBe(1);
      const direct = await concrete('project', 'get', '_', { filterByTk: 102, 'fields[]': ['id'] });
      expect(direct.status).toBe(200);
      expect(direct.body).toEqual({ data: null });
    });

    it('does not expose a target field omitted from its independent role grant', async () => {
      await grant('projects', 'view', ['id']);
      const response = await app
        .agent()
        .resource('documents')
        .get({ filterByTk: 3, fields: ['id', 'project.name'] });
      expect(response.status).toBe(400);
      expect(response.body).not.toHaveProperty('data');
    });

    it('requires source association field permission for concrete access', async () => {
      await grant('documents', 'view', ['id', 'name']);
      const response = await concrete('projects', 'list', 3, { 'fields[]': ['id'] });
      expect(response.status).toBe(400);
      expect(response.body).not.toHaveProperty('data');
    });

    it('requires the independently finalized source list operation', async () => {
      acl.getRole('editor').revokeAction('documents:view');
      const response = await concrete('projects', 'list', 3, { 'fields[]': ['id'] });
      expect(response.status).toBe(403);
      expect(response.body).not.toHaveProperty('data');
    });

    it('rejects a source outside its custom role range', async () => {
      await grant('documents', 'view', ['id', 'projects'], { id: 4 });
      const response = await concrete('projects', 'list', 3, { 'fields[]': ['id'] });
      expect(response.status).toBe(403);
      expect(response.body).not.toHaveProperty('data');
    });

    it('does not reveal associations from a hidden source', async () => {
      await app.db.getCollection('documents').model.update({ name: 'Hidden', tenantId: 'C' }, { where: { id: 3 } });
      const response = await concrete('projects', 'list', 3, { 'fields[]': ['id'] });
      expect(response.status).toBe(403);
      expect(response.body).not.toHaveProperty('data');
    });

    it.each(['project', 'projects'])('keeps target visibility on /_/ %s list', async (relation) => {
      const response = await concrete(relation, 'list', '_', { 'fields[]': ['id'], sort: 'id' });
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([{ id: 101 }, { id: 102 }]);
      expect(response.body.meta.count).toBe(2);
    });

    it.each(['project', 'projects'])('denies /_/ %s when the target operation is missing', async (relation) => {
      acl.getRole('editor').revokeAction('projects:view');
      const response = await concrete(relation, 'get', '_', { filterByTk: 102, 'fields[]': ['id'] });
      expect(response.status).toBe(403);
      expect(response.body).not.toHaveProperty('data');
    });

    it('excludes unreadable links from expansion, concrete lists, root filtering and count', async () => {
      await configureLinks(false);
      const detail = await app
        .agent()
        .resource('documents')
        .get({ filterByTk: 3, fields: ['id', 'projects.id'] });
      const associated = await concrete('projects', 'list', 3, { 'fields[]': ['id'] });
      const filter = { projects: { id: 101 } };
      const roots = await app
        .agent()
        .resource('documents')
        .list({ fields: ['id'], filter });
      const count = await app.agent().resource('documents').count({ filter });
      expect(detail.status).toBe(200);
      expect(detail.body).toEqual({ data: { id: 3, projects: [] } });
      expect(associated.status).toBe(200);
      expect(associated.body.data).toEqual([]);
      expect(associated.body.meta.count).toBe(0);
      expect(roots.status).toBe(200);
      expect(roots.body.data).toEqual([]);
      expect(roots.body.meta.count).toBe(0);
      expect(count.status).toBe(200);
      expect(count.body).toEqual({ data: 0 });
    });

    it('requires the through collection operation instead of treating it as a public join', async () => {
      acl.getRole('editor').revokeAction('document_projects:view');
      const response = await concrete('projects', 'list', 3, { 'fields[]': ['id'] });
      expect(response.status).toBe(403);
      expect(response.body).not.toHaveProperty('data');
    });

    it('cannot match roots by a hidden target even though the raw link exists', async () => {
      const response = await app
        .agent()
        .resource('documents')
        .list({ fields: ['id'], filter: { projects: { id: 103 } } });
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
      expect(response.body.meta.count).toBe(0);
      expect(await links()).toEqual([101, 102, 103]);
    });
  });

  describe('creation with existing references', () => {
    beforeEach(async () => {
      acl.setAvailableAction('create', {});
      await grant('documents', 'create', ['name', 'project', 'projects']);
    });

    const create = (values: object) => app.agent().resource('documents').create({ values });
    const newRows = () => app.db.getCollection('documents').model.findAll({ where: { name: 'Created' } });

    it('allows omitted association grants when creating only ordinary fields', async () => {
      const response = await create({ name: 'Created' });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: { keys: [expect.any(Number)], affected: 1 } });
      const id = response.body.data.keys[0];
      expect(await row('documents', id)).toEqual({ id, name: 'Created', tenantId: 'B', projectId: null });
      expect(await links()).toEqual([]);
    });

    it('allows omitted association grants when updating only ordinary fields', async () => {
      await app.db.getCollection('documents').model.update({ projectId: 103 }, { where: { id: 3 } });
      await seedLinks([103]);
      acl.getRole('editor').revokeAction('projects:view');
      const response = await update({ name: 'Edited' });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
      expect(await row()).toEqual({ id: 3, name: 'Edited', tenantId: 'B', projectId: 103 });
      expect(await links()).toEqual([103]);
      expect(await row('projects', 103)).toEqual({ id: 103, name: 'Hidden', tenantId: 'C' });
    });

    it.each([{ project: 102 }, { projects: [101, 102] }, { project: 102, projects: [101, 102] }])(
      'creates an owned record with readable existing references: %j',
      async (references) => {
        const response = await create({ name: 'Created', ...references });
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ data: { keys: [expect.any(Number)], affected: 1 } });
        const id = response.body.data.keys[0];
        expect(await row('documents', id)).toEqual({
          id,
          name: 'Created',
          tenantId: 'B',
          projectId: references.project ?? null,
        });
        expect(await links()).toEqual(references.projects ?? []);
        const read = await app.agent().resource('documents').get({ filterByTk: id });
        expect(read.status).toBe(200);
        expect(read.body.data).toEqual({ id, name: 'Created' });
        expect(await row('projects', 102)).toEqual({ id: 102, name: 'Visible', tenantId: 'H' });
        expect(await app.db.getCollection('projects').model.count()).toBe(3);
      },
    );

    it.each([{ project: 103 }, { projects: [101, 103] }])(
      'does not persist a record or links when a target is hidden: %j',
      async (references) => {
        const response = await create({ name: 'Created', ...references });
        expect(response.status).toBe(403);
        expect(response.body).not.toHaveProperty('data');
        expect(await newRows()).toHaveLength(0);
        expect(await links()).toEqual([]);
        expect(await row('projects', 103)).toEqual({ id: 103, name: 'Hidden', tenantId: 'C' });
      },
    );

    it('requires list authorization for non-empty references', async () => {
      acl.getRole('editor').revokeAction('projects:view');
      const response = await create({ name: 'Created', project: 102, projects: [101] });
      expect(response.status).toBe(403);
      expect(response.body).not.toHaveProperty('data');
      expect(await newRows()).toHaveLength(0);
      expect(await links()).toEqual([]);
    });

    it('does not require target write permission to reference a visible target', async () => {
      acl.getRole('editor').revokeAction('projects:update');
      const response = await create({ name: 'Created', project: 102, projects: [102] });
      expect(response.status).toBe(200);
      expect(await links()).toEqual([102]);
      expect(await row('projects', 102)).toEqual({ id: 102, name: 'Visible', tenantId: 'H' });
    });

    it('requires the source create operation', async () => {
      acl.getRole('editor').revokeAction('documents:create');
      const response = await create({ name: 'Created', project: 102, projects: [101] });
      expect(response.status).toBe(403);
      expect(response.body).not.toHaveProperty('data');
      expect(await app.db.getCollection('documents').model.count()).toBe(2);
      expect(await links()).toEqual([]);
    });

    it.each(['project', 'projects'] as const)('requires the submitted %s field grant', async (field) => {
      await grant('documents', 'create', ['name']);
      const response = await create({ name: 'Created', [field]: field === 'project' ? 102 : [102] });
      expect(response.status).toBe(400);
      expect(response.body).not.toHaveProperty('data');
      expect(await app.db.getCollection('documents').model.count()).toBe(2);
      expect(await links()).toEqual([]);
    });

    it('requires the referenced primary key to be readable', async () => {
      await grant('projects', 'view', ['name']);
      const response = await create({ name: 'Created', project: 102, projects: [101] });
      expect(response.status).toBe(400);
      expect(response.body).not.toHaveProperty('data');
      expect(await app.db.getCollection('documents').model.count()).toBe(2);
      expect(await links()).toEqual([]);
    });

    it('retains the target custom role filter', async () => {
      await grant('projects', 'view', ['id'], { id: 101 });
      const response = await create({ name: 'Created', project: 102, projects: [101] });
      expect(response.status).toBe(403);
      expect(response.body).not.toHaveProperty('data');
      expect(await app.db.getCollection('documents').model.count()).toBe(2);
      expect(await links()).toEqual([]);
    });

    it('allows null and empty selections without target list permission', async () => {
      acl.getRole('editor').revokeAction('projects:view');
      const response = await create({ name: 'Created', project: null, projects: [] });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: { keys: [expect.any(Number)], affected: 1 } });
      const id = response.body.data.keys[0];
      expect(await row('documents', id)).toEqual({ id, name: 'Created', tenantId: 'B', projectId: null });
      expect(await links()).toEqual([]);
      expect(await app.db.getCollection('projects').model.count()).toBe(3);
    });

    it('does not claim a readable historical target', async () => {
      await app.db.getCollection('projects').model.update({ tenantId: null }, { where: { id: 102 } });
      const response = await create({ name: 'Created', project: 102, projects: [102] });
      expect(response.status).toBe(200);
      expect(await links()).toEqual([102]);
      expect(await row('projects', 102)).toEqual({ id: 102, name: 'Visible', tenantId: null });
    });

    it('does not let source visibility grant creation', async () => {
      const source = identity(app.db.getCollection('documents'));
      const config = (await store.read(source))!;
      await store.save(
        source,
        { ...configFor({ type: 'constant', value: true }, 'visibility'), revision: config.revision },
        { userId: 28 },
      );
      const response = await create({ name: 'Created', project: 102, projects: [101] });
      expect(response.status).toBe(403);
      expect(response.body).not.toHaveProperty('data');
      expect(await app.db.getCollection('documents').model.count()).toBe(2);
      expect(await links()).toEqual([]);
    });

    it('evaluates source role conditions against persisted links', async () => {
      await grant('documents', 'create', ['name', 'project', 'projects'], { projects: { id: 101 } });
      const denied = await create({ name: 'Created', project: 102, projects: [102] });
      expect(denied.status).toBe(403);
      expect(denied.body).not.toHaveProperty('data');
      expect(await app.db.getCollection('documents').model.count()).toBe(2);
      expect(await links()).toEqual([]);
      const allowed = await create({ name: 'Created', project: 102, projects: [101, 102] });
      expect(allowed.status).toBe(200);
      expect(await links()).toEqual([101, 102]);
      expect(await app.db.getCollection('documents').model.count()).toBe(3);
    });

    it('rejects forged ownership without leaving a new record or links', async () => {
      const response = await create({ name: 'Created', tenantId: 'C', project: 102, projects: [101] });
      expect(response.status).toBe(403);
      expect(response.body).not.toHaveProperty('data');
      expect(await app.db.getCollection('documents').model.count()).toBe(2);
      expect(await links()).toEqual([]);
    });

    it('rejects nested target edits rather than silently creating or changing a target', async () => {
      const response = await create({ name: 'Created', project: { id: 102, name: 'Changed' }, projects: [101] });
      expect(response.status).toBe(400);
      expect(response.body).not.toHaveProperty('data');
      expect(await app.db.getCollection('documents').model.count()).toBe(2);
      expect(await app.db.getCollection('projects').model.count()).toBe(3);
      expect(await row('projects', 102)).toEqual({ id: 102, name: 'Visible', tenantId: 'H' });
      expect(await links()).toEqual([]);
    });

    it('rolls back a persisted source and inserted links when a join hook fails', async () => {
      let observed: unknown;
      app.db.getCollection('document_projects').model.addHook('afterBulkCreate', async (_records, options) => {
        const created = await app.db.getCollection('documents').model.findOne({
          where: { name: 'Created' },
          transaction: options.transaction,
        });
        const inserted = await app.db.getCollection('document_projects').model.findAll({
          order: [['projectId', 'ASC']],
          transaction: options.transaction,
        });
        observed = {
          source: created && {
            name: created.get('name'),
            tenantId: created.get('tenantId'),
            projectId: created.get('projectId'),
          },
          links: inserted.map((record) => Number(record.get('projectId'))),
        };
        throw new Error('HTTP creation rollback fixture');
      });
      const response = await create({ name: 'Created', project: 102, projects: [101, 102] });
      expect(response.status).toBe(500);
      expect(response.body).not.toHaveProperty('data');
      expect(observed).toEqual({ source: { name: 'Created', tenantId: 'B', projectId: 102 }, links: [101, 102] });
      expect(await app.db.getCollection('documents').model.count()).toBe(2);
      expect(await links()).toEqual([]);
      expect(await row('projects', 102)).toEqual({ id: 102, name: 'Visible', tenantId: 'H' });
    });
  });

  describe('target foreign-key writes', () => {
    beforeEach(async () => {
      const db = app.db;
      const docs = db.getCollection('documents');
      for (const [name, association, type] of [
        ['children', 'children', 'hasMany'],
        ['profiles', 'profile', 'hasOne'],
      ] as const) {
        db.collection({
          name,
          timestamps: false,
          fields: [
            { name: 'id', type: 'integer', primaryKey: true },
            { name: 'tenantId', type: 'string' },
            { name: 'name', type: 'string' },
            { name: 'documentId', type: 'integer', field: 'document_id' },
          ],
        });
        docs.setField(association, { type, target: name, foreignKey: 'documentId' });
        const target = db.getCollection(name);
        target.setField('document', { type: 'belongsTo', target: 'documents', foreignKey: 'documentId' });
        await db.getRepository('collections').create({ values: { key: `${name}-key`, name } });
        await grant(name, 'view', ['id']);
        await grant(name, 'update', ['document']);
      }
      await db.sync();
      for (const name of ['children', 'profiles'])
        await db.getCollection(name).model.bulkCreate([
          { id: 201, name: 'Owned', tenantId: 'B', documentId: null },
          { id: 202, name: 'Visible', tenantId: 'H', documentId: null },
          { id: 203, name: 'Hidden', tenantId: 'C', documentId: null },
          { id: 205, name: 'Owned', tenantId: 'B', documentId: 3 },
        ]);
      await grant('documents', 'update', ['name', 'children', 'profile']);
      // Visibility is deliberately separate from ownership, including on the modified targets.
      for (const name of ['children', 'profiles']) {
        const target = identity(db.getCollection(name));
        const config = { ...configFor(ownerCondition), revision: 0 };
        await store.save(
          target,
          {
            ...config,
            rules: [
              ...config.rules,
              {
                ...configFor(
                  {
                    type: 'compare',
                    operator: 'eq',
                    left: { type: 'field', path: 'name' },
                    right: { type: 'literal', value: 'Visible' },
                  },
                  'visibility',
                ).rules[0],
                id: 'visible',
              },
            ],
          },
          { userId: 28 },
        );
      }
    });

    describe('target foreign-key reads', () => {
      const read = (relation: string, action: string, source: number | string = 3, query: object = {}) =>
        supertest(app.callback()).get(`/api/documents/${source}/${relation}:${action}`).query(query);

      beforeEach(async () => {
        await grant('documents', 'view', ['id', 'name', 'children', 'profile']);
        for (const name of ['children', 'profiles']) {
          await grant(name, 'view', ['id', 'name']);
          await app.db.getCollection(name).model.update({ documentId: null }, { where: { id: 205 } });
        }
        await app.db.getCollection('children').model.update({ documentId: 3 }, { where: { id: [201, 202, 203] } });
        await app.db.getCollection('profiles').model.update({ documentId: 3 }, { where: { id: 202 } });
        await app.db.getCollection('profiles').model.update({ documentId: 4 }, { where: { id: 203 } });
      });

      it('expands readable children and profiles without losing roots with hidden references', async () => {
        const response = await app
          .agent()
          .resource('documents')
          .list({ fields: ['id', 'children.id', 'profile.id'], sort: ['id'] });
        expect(response.status).toBe(200);
        expect(response.body).toEqual({
          data: [
            { id: 3, children: [{ id: 201 }, { id: 202 }], profile: { id: 202 } },
            { id: 4, children: [], profile: null },
          ],
          meta: { count: 2, page: 1, pageSize: 20, totalPage: 1 },
        });
      });

      it('filters concrete children lists by target visibility', async () => {
        const response = await read('children', 'list', 3, { 'fields[]': ['id'], sort: 'id' });
        expect(response.status).toBe(200);
        expect(response.body).toEqual({
          data: [{ id: 201 }, { id: 202 }],
          meta: { count: 2, page: 1, pageSize: 20, totalPage: 1 },
        });
      });

      it.each([3, 4])('gets the readable profile of source %s', async (source) => {
        const response = await read('profile', 'get', source, { 'fields[]': ['id'] });
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ data: source === 3 ? { id: 202 } : null });
      });

      it.each([
        ['children', { id: 202 }],
        ['profile', { id: 202 }],
      ] as const)('reads a visible-only linked target through %s without claiming it', async (relation, expected) => {
        const response = await read(relation, 'get', 3, { filterByTk: 202, 'fields[]': ['id'] });
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ data: expected });
        expect(await row(relation === 'children' ? 'children' : 'profiles', 202)).toEqual({
          id: 202,
          name: 'Visible',
          tenantId: 'H',
          documentId: 3,
        });
      });

      it('does not reveal a hidden or unlinked target through children:get', async () => {
        for (const filterByTk of [203, 205]) {
          const response = await read('children', 'get', 3, { filterByTk, 'fields[]': ['id'] });
          expect(response.status).toBe(200);
          expect(response.body).toEqual({ data: null });
        }
      });

      it('locates the single profile by its source rather than a supplied target key', async () => {
        const response = await read('profile', 'get', 3, { filterByTk: 205, 'fields[]': ['id'] });
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ data: { id: 202 } });
      });

      it.each(['children', 'profile'])(
        'requires the source association field for concrete %s reads',
        async (relation) => {
          await grant('documents', 'view', ['id', 'name']);
          const response = await read(relation, 'get', 3, { filterByTk: 202, 'fields[]': ['id'] });
          expect(response.status).toBe(400);
          expect(response.body).not.toHaveProperty('data');
        },
      );

      it.each(['children', 'profile'])(
        'requires the independent source action for concrete %s reads',
        async (relation) => {
          acl.getRole('editor').revokeAction('documents:view');
          const response = await read(relation, 'get', 3, { filterByTk: 202, 'fields[]': ['id'] });
          expect(response.status).toBe(403);
          expect(response.body).not.toHaveProperty('data');
        },
      );

      it.each(['children', 'profile'])('retains source role conditions for concrete %s reads', async (relation) => {
        await grant('documents', 'view', ['id', relation], { id: 4 });
        const response = await read(relation, 'get', 3, { filterByTk: 202, 'fields[]': ['id'] });
        expect(response.status).toBe(403);
        expect(response.body).not.toHaveProperty('data');
      });

      it.each(['children', 'profile'])('rejects concrete %s reads from a hidden source', async (relation) => {
        await app.db.getCollection('documents').model.update({ name: 'Hidden', tenantId: 'C' }, { where: { id: 3 } });
        const response = await read(relation, 'get', 3, { filterByTk: 202, 'fields[]': ['id'] });
        expect(response.status).toBe(403);
        expect(response.body).not.toHaveProperty('data');
      });

      it.each([
        ['children', 'children'],
        ['profile', 'profiles'],
      ] as const)('reads %s from a visible-only source', async (relation, target) => {
        await app.db.getCollection(target).model.update({ documentId: null }, { where: { id: 203 } });
        await app.db.getCollection(target).model.update({ documentId: 4 }, { where: { id: 201 } });
        const response = await read(relation, 'get', 4, { filterByTk: 201, 'fields[]': ['id'] });
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ data: { id: 201 } });
        expect(await row('documents', 4)).toEqual({ id: 4, name: 'Visible', tenantId: 'H', projectId: null });
      });

      it.each([
        ['children', 'children'],
        ['profile', 'profiles'],
      ] as const)('keeps target field restrictions on %s expansion', async (relation, target) => {
        await grant(target, 'view', ['id']);
        const response = await app
          .agent()
          .resource('documents')
          .get({ filterByTk: 3, fields: ['id', `${relation}.name`] });
        expect(response.status).toBe(400);
        expect(response.body).not.toHaveProperty('data');
      });

      it.each([
        ['children', 'children'],
        ['profile', 'profiles'],
      ] as const)('keeps independent target role conditions on %s reads', async (relation, target) => {
        await grant(target, 'view', ['id', 'name'], { id: 201 });
        const response = await read(relation, 'get', 3, { filterByTk: 202, 'fields[]': ['id'] });
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ data: null });
        const placeholder = await read(relation, 'get', '_', { filterByTk: 202, 'fields[]': ['id'] });
        expect(placeholder.status).toBe(200);
        expect(placeholder.body).toEqual({ data: null });
      });

      it.each(['children', 'profile'])(
        'reads /_/ %s without source permission while filtering target visibility',
        async (relation) => {
          acl.getRole('editor').revokeAction('documents:view');
          const detail = await read(relation, 'get', '_', { filterByTk: 202, 'fields[]': ['id'] });
          expect(detail.status).toBe(200);
          expect(detail.body).toEqual({ data: { id: 202 } });
          const list = await read(relation, 'list', '_', { 'fields[]': ['id'], sort: 'id' });
          expect(list.status).toBe(200);
          expect(list.body).toEqual({
            data: [{ id: 201 }, { id: 202 }, { id: 205 }],
            meta: { count: 3, page: 1, pageSize: 20, totalPage: 1 },
          });
        },
      );

      it.each([
        ['children', 'children'],
        ['profile', 'profiles'],
      ] as const)('requires the target action on both concrete and /_/ %s reads', async (relation, target) => {
        acl.getRole('editor').revokeAction(`${target}:view`);
        for (const source of [3, '_']) {
          const response = await read(relation, 'get', source, { filterByTk: 202, 'fields[]': ['id'] });
          expect(response.status).toBe(403);
          expect(response.body).not.toHaveProperty('data');
        }
      });

      it.each(['children', 'profile'])('uses readable %s for root filtering and count', async (relation) => {
        for (const [name, expected] of [
          ['Visible', [{ id: 3 }]],
          ['Hidden', []],
        ] as const) {
          const filter = { [relation]: { name } };
          const list = await app
            .agent()
            .resource('documents')
            .list({ fields: ['id'], filter });
          const count = await app.agent().resource('documents').count({ filter });
          expect(list.status).toBe(200);
          expect(list.body.data).toEqual(expected);
          expect(list.body.meta.count).toBe(expected.length);
          expect(count.status).toBe(200);
          expect(count.body).toEqual({ data: expected.length });
        }
      });

      it('counts only readable targets on concrete children requests', async () => {
        const response = await read('children', 'count');
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ data: 2 });
      });

      it('rejects unsupported concrete single-profile count requests', async () => {
        const response = await read('profile', 'count');
        expect(response.status).toBe(400);
        expect(response.body).not.toHaveProperty('data');
      });

      it('applies concrete children filters and pagination before counting returned pages', async () => {
        const visible = await read('children', 'list', 3, {
          'fields[]': ['id'],
          filter: JSON.stringify({ name: 'Visible' }),
        });
        expect(visible.status).toBe(200);
        expect(visible.body.data).toEqual([{ id: 202 }]);
        expect(visible.body.meta.count).toBe(1);
        const secondPage = await read('children', 'list', 3, { 'fields[]': ['id'], sort: 'id', pageSize: 1, page: 2 });
        expect(secondPage.status).toBe(200);
        expect(secondPage.body).toEqual({
          data: [{ id: 202 }],
          meta: { count: 2, page: 2, pageSize: 1, totalPage: 2 },
        });
      });

      it('returns null for a genuinely absent profile', async () => {
        await app.db.getCollection('profiles').model.update({ documentId: null }, { where: { id: 202 } });
        const response = await read('profile', 'get', 3, { 'fields[]': ['id'] });
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ data: null });
      });
    });

    const selected = async (target: string, source = 3) =>
      (
        await app.db.getCollection(target).model.findAll({
          where: { documentId: source },
          order: [['id', 'ASC']],
        })
      ).map((record) => Number(record.get('id')));
    async function grantChild(association: 'children' | 'profile', operation: 'add' | 'remove' | 'set') {
      acl.setAvailableAction(operation, {});
      await grant('documents', operation, [association]);
      await grant(association === 'children' ? 'children' : 'profiles', operation, ['id']);
    }
    const childRequest = (
      association: 'children' | 'profile',
      operation: 'add' | 'remove' | 'set',
      id?: number,
      source: number | string = 3,
    ) =>
      supertest(app.callback()).post(
        `/api/documents/${source}/${association}:${operation}${id === undefined ? '' : `?filterByTk=${id}`}`,
      );

    it.each([
      { association: 'children', target: 'children', operation: 'add', id: 201, expected: [201, 205], changed: [201] },
      { association: 'children', target: 'children', operation: 'remove', id: 205, expected: [], changed: [205] },
      { association: 'children', target: 'children', operation: 'set', id: 201, expected: [201], changed: [201, 205] },
      { association: 'profile', target: 'profiles', operation: 'set', id: 201, expected: [201], changed: [201, 205] },
      { association: 'profile', target: 'profiles', operation: 'remove', id: undefined, expected: [], changed: [205] },
    ] as const)('writes only the foreign key through $association:$operation', async (test) => {
      await grantChild(test.association, test.operation);
      const response = await childRequest(test.association, test.operation, test.id);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: { keys: test.changed, affected: test.changed.length } });
      expect(await selected(test.target)).toEqual(test.expected);
      expect(await row(test.target, 201)).toEqual({
        id: 201,
        tenantId: 'B',
        name: 'Owned',
        documentId: test.operation === 'remove' ? null : 3,
      });
      expect(await row(test.target, 205)).toEqual({
        id: 205,
        tenantId: 'B',
        name: 'Owned',
        documentId: test.operation === 'add' ? 3 : null,
      });
      expect(await row()).toEqual({ id: 3, name: 'Owned', tenantId: 'B', projectId: null });
    });

    it.each([
      ['children', 'children'],
      ['profile', 'profiles'],
    ] as const)('rejects a visible-only target in %s:set', async (association, target) => {
      await grantChild(association, 'set');
      const response = await childRequest(association, 'set', 202);
      expect(response.status).toBe(403);
      expect(response.body).not.toHaveProperty('data');
      expect(await selected(target)).toEqual([205]);
      expect(await row(target, 202)).toEqual({ id: 202, tenantId: 'H', name: 'Visible', documentId: null });
    });

    describe.each([
      ['children', 'children', [201]],
      ['profile', 'profiles', 201],
    ] as const)('%s authorization and atomicity', (association, target, selection) => {
      it('keeps a visible-only source read-only', async () => {
        await grantChild(association, 'set');
        const response = await childRequest(association, 'set', 201, 4);
        expect(response.status).toBe(403);
        expect(response.body).not.toHaveProperty('data');
        expect(await selected(target, 4)).toEqual([]);
        expect(await selected(target)).toEqual([205]);
        expect(await row('documents', 4)).toEqual({ id: 4, name: 'Visible', tenantId: 'H', projectId: null });
      });

      it.each(['documents', 'target', 'update'] as const)(
        'requires the independent %s operation grant',
        async (decision) => {
          await grantChild(association, 'set');
          acl
            .getRole('editor')
            .revokeAction(
              decision === 'update' ? `${target}:update` : `${decision === 'documents' ? 'documents' : target}:set`,
            );
          const response = await childRequest(association, 'set', 201);
          expect(response.status).toBe(403);
          expect(response.body).not.toHaveProperty('data');
          expect(await selected(target)).toEqual([205]);
          expect((await row(target, 201)).documentId).toBeNull();
        },
      );

      it('requires field permission for the child foreign key', async () => {
        await grantChild(association, 'set');
        await grant(target, 'update', ['name']);
        const response = await childRequest(association, 'set', 201);
        expect(response.status).toBe(400);
        expect(response.body).not.toHaveProperty('data');
        expect(await selected(target)).toEqual([205]);
        expect((await row(target, 201)).documentId).toBeNull();
      });

      it('requires field permission for the source association', async () => {
        await grantChild(association, 'set');
        await grant('documents', 'set', ['name']);
        const response = await childRequest(association, 'set', 201);
        expect(response.status).toBe(400);
        expect(response.body).not.toHaveProperty('data');
        expect(await selected(target)).toEqual([205]);
      });

      it('retains the source action filter', async () => {
        await grantChild(association, 'set');
        await grant('documents', 'set', [association], { id: 4 });
        const response = await childRequest(association, 'set', 201);
        expect(response.status).toBe(403);
        expect(response.body).not.toHaveProperty('data');
        expect(await selected(target)).toEqual([205]);
      });

      it.each(['set', 'update'] as const)(
        'checks the %s role filter on implicitly detached children',
        async (action) => {
          await grantChild(association, 'set');
          await grant(target, action, action === 'set' ? ['id'] : ['document'], { id: 201 });
          const response = await childRequest(association, 'set', 201);
          expect(response.status).toBe(403);
          expect(response.body).not.toHaveProperty('data');
          expect(await selected(target)).toEqual([205]);
          expect((await row(target, 201)).documentId).toBeNull();
        },
      );

      it('retains list conditions for the selected child', async () => {
        await grantChild(association, 'set');
        await grant(target, 'view', ['id'], { id: 205 });
        const response = await childRequest(association, 'set', 201);
        expect(response.status).toBe(403);
        expect(response.body).not.toHaveProperty('data');
        expect(await selected(target)).toEqual([205]);
      });

      it('requires list permission even for an explicitly selected unchanged child', async () => {
        await grantChild(association, 'set');
        acl.getRole('editor').revokeAction(`${target}:view`);
        const response = await childRequest(association, 'set', 205);
        expect(response.status).toBe(403);
        expect(response.body).not.toHaveProperty('data');
        expect(await selected(target)).toEqual([205]);
      });

      it('does not require child update permission for a true no-op', async () => {
        await grantChild(association, 'set');
        acl.getRole('editor').revokeAction(`${target}:update`);
        const response = await childRequest(association, 'set', 205);
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ data: { keys: [], affected: 0 } });
        expect(await selected(target)).toEqual([205]);
      });

      it('saves source scalars and a child selection together', async () => {
        const response = await update({ name: 'Edited', [association]: selection });
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
        expect(await selected(target)).toEqual([201]);
        expect(await row()).toEqual({ id: 3, name: 'Edited', tenantId: 'B', projectId: null });
        expect(await row(target, 201)).toEqual({ id: 201, name: 'Owned', tenantId: 'B', documentId: 3 });
        expect(await row(target, 205)).toEqual({ id: 205, name: 'Owned', tenantId: 'B', documentId: null });
      });

      it('supports scalar-filtered child replacement with source edits', async () => {
        const response = await supertest(app.callback())
          .post('/api/documents:update')
          .query({ filterByTk: 3, filter: JSON.stringify({ name: { $startsWith: 'Own' } }) })
          .send({ name: 'Edited', [association]: selection });
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
        expect(await selected(target)).toEqual([201]);
        expect(await row()).toMatchObject({ name: 'Edited', tenantId: 'B' });
        expect((await row(target, 201)).documentId).toBe(3);
        expect((await row(target, 205)).documentId).toBeNull();
      });

      it('accepts an empty HTTP filter with source scalars and a child replacement', async () => {
        const response = await supertest(app.callback())
          .post('/api/documents:update?filterByTk=3&filter=%7B%7D')
          .send({ name: 'Edited', [association]: selection });
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
        expect(await selected(target)).toEqual([201]);
        expect(await row()).toEqual({ id: 3, name: 'Edited', tenantId: 'B', projectId: null });
        expect(await row(target, 201)).toEqual({ id: 201, name: 'Owned', tenantId: 'B', documentId: 3 });
        expect((await row(target, 205)).documentId).toBeNull();
      });

      it('supports relational-filtered child replacement with source edits', async () => {
        await grant('documents', 'view', ['id', 'name', 'project']);
        await app.db.getCollection('documents').model.update({ projectId: 101 }, { where: { id: 3 } });
        const response = await supertest(app.callback())
          .post('/api/documents:update')
          .query({ filterByTk: 3, filter: JSON.stringify({ project: { name: 'Owned' } }) })
          .send({ name: 'Edited', [association]: selection });
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
        expect(await selected(target)).toEqual([201]);
        expect(await row()).toMatchObject({ name: 'Edited', tenantId: 'B', projectId: 101 });
        expect((await row(target, 201)).documentId).toBe(3);
        expect((await row(target, 205)).documentId).toBeNull();
      });

      describe('relational-filtered child update boundaries', () => {
        const filteredUpdate = (values: object, filter: object = { project: { name: 'Owned' } }, source = 3) =>
          supertest(app.callback())
            .post('/api/documents:update')
            .query({ filterByTk: source, filter: JSON.stringify(filter) })
            .send(values);

        beforeEach(async () => {
          await grant('documents', 'view', ['id', 'name', 'project']);
          await app.db.getCollection('documents').model.update({ projectId: 101 }, { where: { id: [3, 4] } });
        });

        it('rolls back persisted source and both children after concurrent filter revocation', async () => {
          await app.db.getCollection('documents').model.update({ projectId: 102 }, { where: { id: 3 } });
          await assertConcurrentFilterRollback(
            () => filteredUpdate({ name: 'Changed', [association]: selection }, { project: { name: 'Visible' } }),
            'Revoked',
            target,
          );
          expect(await selected(target)).toEqual([205]);
          expect((await row(target, 201)).documentId).toBeNull();
          const afterRevocation = await filteredUpdate(
            { name: 'Changed', [association]: selection },
            { project: { name: 'Visible' } },
          );
          expect(afterRevocation.status).toBe(403);
          expect(await selected(target)).toEqual([205]);
          expect(await row()).toMatchObject({ name: 'Owned', tenantId: 'B', projectId: 102 });
        });

        it('preserves the real COMMIT failure after persisting source and both children', async () => {
          await app.db.getCollection('documents').model.update({ projectId: 102 }, { where: { id: 3 } });
          await assertConcurrentFilterRollback(
            () => filteredUpdate({ name: 'Changed', [association]: selection }, { project: { name: 'Visible' } }),
            'Revoked',
            target,
            'commit',
          );
          expect(await selected(target)).toEqual([205]);
          expect((await row(target, 201)).documentId).toBeNull();
        });

        it.each([
          'request',
          'source-read',
          'source-path',
          'source-write',
          'source-owner',
          'filter-read',
          'filter-field',
          'filter-role',
          'filter-hidden',
          'child-read',
          'child-owner',
          'child-field',
          'selected-write',
          'detached-write',
          'detached-owner',
        ])('rejects the independent %s boundary before any source or child edit', async (boundary) => {
          if (boundary === 'source-read') acl.getRole('editor').revokeAction('documents:view');
          if (boundary === 'source-path') await grant('documents', 'view', ['id', 'name']);
          if (boundary === 'source-write') await grant('documents', 'update', ['name', association], { id: 4 });
          if (boundary === 'filter-read') acl.getRole('editor').revokeAction('projects:view');
          if (boundary === 'filter-field') await grant('projects', 'view', ['id']);
          if (boundary === 'filter-role') await grant('projects', 'view', ['id', 'name'], { id: 102 });
          if (boundary === 'filter-hidden')
            await app.db.getCollection('documents').model.update({ projectId: 103 }, { where: { id: 3 } });
          if (boundary === 'child-read') await grant(target, 'view', ['id'], { id: 205 });
          if (boundary === 'child-field') await grant(target, 'update', ['name']);
          if (boundary === 'selected-write') await grant(target, 'update', ['document'], { id: 205 });
          if (boundary === 'detached-write') await grant(target, 'update', ['document'], { id: 201 });
          if (boundary === 'detached-owner')
            await app.db.getCollection(target).model.update({ tenantId: 'H', name: 'Visible' }, { where: { id: 205 } });
          const child = boundary === 'child-owner' ? 202 : 201;
          const response = await filteredUpdate(
            { name: 'Forbidden', [association]: association === 'children' ? [child] : child },
            { project: { name: boundary === 'request' ? 'Other' : boundary === 'filter-hidden' ? 'Hidden' : 'Owned' } },
            boundary === 'source-owner' ? 4 : 3,
          );
          expect(response.status).toBeGreaterThanOrEqual(400);
          expect(response.status).toBeLessThan(500);
          expect(response.body).not.toHaveProperty('data');
          expect(await row()).toMatchObject({ name: 'Owned', tenantId: 'B' });
          expect(await row('documents', 4)).toMatchObject({ name: 'Visible', tenantId: 'H' });
          expect(await selected(target)).toEqual([205]);
          expect((await row(target, 201)).documentId).toBeNull();
          expect((await row(target, 202)).documentId).toBeNull();
        });

        it('rejects a mismatching relational condition even when no source scalars are submitted', async () => {
          const response = await filteredUpdate({ [association]: selection }, { project: { name: 'Other' } });
          expect(response.status).toBe(403);
          expect(response.body).not.toHaveProperty('data');
          expect(await selected(target)).toEqual([205]);
          expect((await row(target, 201)).documentId).toBeNull();
          expect(await row()).toMatchObject({ name: 'Owned', tenantId: 'B' });
        });

        it('uses a visible-only filter target without editing or claiming it', async () => {
          await app.db.getCollection('documents').model.update({ projectId: 102 }, { where: { id: 3 } });
          const response = await filteredUpdate({ [association]: selection }, { project: { name: 'Visible' } });
          expect(response.status).toBe(200);
          expect(await selected(target)).toEqual([201]);
          expect(await row('projects', 102)).toEqual({ id: 102, name: 'Visible', tenantId: 'H' });
        });

        it('clears an unreadable old child without requiring its list grant', async () => {
          acl.getRole('editor').revokeAction(`${target}:view`);
          const response = await filteredUpdate({ [association]: association === 'children' ? [] : null });
          expect(response.status).toBe(200);
          expect(await selected(target)).toEqual([]);
          expect((await row(target, 205)).documentId).toBeNull();
        });

        it('does not require child write permission when only source scalars change', async () => {
          acl.getRole('editor').revokeAction(`${target}:update`);
          const response = await filteredUpdate({
            name: 'Edited',
            [association]: association === 'children' ? [205] : 205,
          });
          expect(response.status).toBe(200);
          expect(await row()).toMatchObject({ name: 'Edited' });
          expect(await selected(target)).toEqual([205]);
        });

        it.each([false, true])(
          'claims a historical source only for a real child edit (changed=%s)',
          async (changed) => {
            const docs = app.db.getCollection('documents');
            const key = identity(docs);
            const previous = (await store.read(key))!;
            await store.save(
              key,
              { ...configFor({ type: 'constant', value: true }), revision: previous.revision },
              { userId: 28 },
            );
            await docs.model.update({ tenantId: null }, { where: { id: 3 } });
            const response = await filteredUpdate({
              [association]: changed ? selection : association === 'children' ? [205] : 205,
            });
            expect(response.status).toBe(200);
            expect(await row()).toMatchObject({ name: 'Owned', tenantId: changed ? 'B' : null });
            expect(await selected(target)).toEqual(changed ? [201] : [205]);
            expect(await row('projects', 101)).toEqual({ id: 101, name: 'Owned', tenantId: 'B' });
          },
        );

        it('matches the old child before replacing it, without applying the old condition after saving', async () => {
          await grant('documents', 'view', ['id', 'name', association]);
          await grant(target, 'view', ['id', 'name']);
          await app.db.getCollection(target).model.update({ name: 'Replacement' }, { where: { id: 201 } });
          const response = await filteredUpdate({ [association]: selection }, { [association]: { name: 'Owned' } });
          expect(response.status).toBe(200);
          expect(await selected(target)).toEqual([201]);
          expect((await row(target, 201)).name).toBe('Replacement');
          expect((await row(target, 205)).documentId).toBeNull();
        });

        it('rolls back source and both child writes after a late failure', async () => {
          let observed: unknown;
          app.db.getCollection(target).model.addHook('afterUpdate', async (_record, options) => {
            const children = await app.db.getCollection(target).model.findAll({
              where: { id: [201, 205] },
              order: [['id', 'ASC']],
              transaction: options.transaction,
            });
            if (children[0]?.get('documentId') !== 3 || children[1]?.get('documentId') !== null) return;
            const source = await app.db
              .getCollection('documents')
              .model.findByPk(3, { transaction: options.transaction });
            observed = { name: source?.get('name'), children: children.map((child) => child.get('documentId')) };
            throw new Error('Relational child rollback fixture');
          });
          const response = await filteredUpdate({ name: 'Edited', [association]: selection });
          expect(response.status).toBe(500);
          expect(observed).toEqual({ name: 'Edited', children: [3, null] });
          expect(await row()).toMatchObject({ name: 'Owned', tenantId: 'B' });
          expect(await selected(target)).toEqual([205]);
          expect((await row(target, 201)).documentId).toBeNull();
        });
      });

      describe('scalar-filtered child update boundaries', () => {
        const filteredUpdate = (values: object, filter: object = { name: 'Owned' }, source = 3) =>
          supertest(app.callback())
            .post('/api/documents:update')
            .query({ filterByTk: source, filter: JSON.stringify(filter) })
            .send(values);

        it.each([
          'request',
          'source-read',
          'source-field',
          'source-write',
          'source-owner',
          'child-read',
          'child-owner',
          'child-field',
          'selected-write',
          'detached-write',
          'detached-owner',
        ])('rejects the %s boundary without editing source or either child', async (boundary) => {
          if (boundary === 'source-read') await grant('documents', 'view', ['id', 'name'], { name: 'Other' });
          if (boundary === 'source-field') await grant('documents', 'view', ['id']);
          if (boundary === 'source-write') await grant('documents', 'update', ['name', association], { name: 'Other' });
          if (boundary === 'child-read') await grant(target, 'view', ['id'], { id: 205 });
          if (boundary === 'child-field') await grant(target, 'update', ['name']);
          if (boundary === 'selected-write') await grant(target, 'update', ['document'], { id: 205 });
          if (boundary === 'detached-write') await grant(target, 'update', ['document'], { id: 201 });
          if (boundary === 'detached-owner')
            await app.db.getCollection(target).model.update({ tenantId: 'H', name: 'Visible' }, { where: { id: 205 } });
          const source = boundary === 'source-owner' ? 4 : 3;
          const child = boundary === 'child-owner' ? 202 : 201;
          const filter = { name: boundary === 'source-owner' ? 'Visible' : boundary === 'request' ? 'Other' : 'Owned' };
          const response = await filteredUpdate(
            { name: 'Forbidden', [association]: association === 'children' ? [child] : child },
            filter,
            source,
          );
          expect(response.status).toBeGreaterThanOrEqual(400);
          expect(response.body).not.toHaveProperty('data');
          expect(await row()).toMatchObject({ name: 'Owned', tenantId: 'B' });
          expect(await row('documents', 4)).toMatchObject({ name: 'Visible', tenantId: 'H' });
          expect(await selected(target)).toEqual([205]);
          expect((await row(target, 201)).documentId).toBeNull();
          expect((await row(target, 202)).documentId).toBeNull();
        });

        it('clears children with source read and child write grants but no child list grant', async () => {
          acl.getRole('editor').revokeAction(`${target}:view`);
          const response = await filteredUpdate({
            [association]: association === 'children' ? [] : null,
            name: 'Edited',
          });
          expect(response.status).toBe(200);
          expect(await selected(target)).toEqual([]);
          expect(await row()).toMatchObject({ name: 'Edited', tenantId: 'B' });
          expect((await row(target, 205)).documentId).toBeNull();
        });

        it('updates source scalars while retaining a readable unchanged child without child write permission', async () => {
          acl.getRole('editor').revokeAction(`${target}:update`);
          const response = await filteredUpdate({
            [association]: association === 'children' ? [205] : 205,
            name: 'Edited',
          });
          expect(response.status).toBe(200);
          expect(await selected(target)).toEqual([205]);
          expect(await row()).toMatchObject({ name: 'Edited', tenantId: 'B' });
        });

        it('keeps template markers in request filter strings literal', async () => {
          await app.db.getCollection('documents').model.update({ name: '{{ literal name }}' }, { where: { id: 3 } });
          const response = await filteredUpdate(
            { [association]: selection, name: 'Edited' },
            { name: '{{ literal name }}' },
          );
          expect(response.status).toBe(200);
          expect(await selected(target)).toEqual([201]);
          expect(await row()).toMatchObject({ name: 'Edited' });
        });

        it('claims a legacy source only after its scalar filter matches and children change', async () => {
          const docs = app.db.getCollection('documents');
          const key = identity(docs);
          const previous = (await store.read(key))!;
          await store.save(
            key,
            { ...configFor({ type: 'constant', value: true }), revision: previous.revision },
            { userId: 28 },
          );
          await docs.model.create({ id: 5, name: 'Legacy', tenantId: null });
          const rejected = await filteredUpdate({ [association]: selection }, { name: 'Other' }, 5);
          expect(rejected.status).toBeGreaterThanOrEqual(400);
          expect(await row('documents', 5)).toMatchObject({ name: 'Legacy', tenantId: null });
          expect((await row(target, 201)).documentId).toBeNull();
          const allowed = await filteredUpdate({ [association]: selection }, { name: 'Legacy' }, 5);
          expect(allowed.status).toBe(200);
          expect(await row('documents', 5)).toMatchObject({ name: 'Legacy', tenantId: 'B' });
          expect((await row(target, 201)).documentId).toBe(5);
          expect(await selected(target)).toEqual([205]);
        });

        it('does not claim a legacy source when the matching child selection is unchanged', async () => {
          const docs = app.db.getCollection('documents');
          const key = identity(docs);
          const previous = (await store.read(key))!;
          await store.save(
            key,
            { ...configFor({ type: 'constant', value: true }), revision: previous.revision },
            { userId: 28 },
          );
          await docs.model.update({ tenantId: null }, { where: { id: 3 } });
          const response = await filteredUpdate({ [association]: association === 'children' ? [205] : 205 });
          expect(response.status).toBe(200);
          expect(await row()).toMatchObject({ name: 'Owned', tenantId: null });
          expect(await selected(target)).toEqual([205]);
        });
      });

      it('rejects implicit detachment of a visible-only child before changing source scalars', async () => {
        await app.db.getCollection(target).model.update({ tenantId: 'H', name: 'Visible' }, { where: { id: 205 } });
        const response = await update({ name: 'Must not persist', [association]: selection });
        expect(response.status).toBe(403);
        expect(response.body).not.toHaveProperty('data');
        expect(await row()).toEqual({ id: 3, name: 'Owned', tenantId: 'B', projectId: null });
        expect(await selected(target)).toEqual([205]);
        expect(await row(target, 205)).toEqual({ id: 205, name: 'Visible', tenantId: 'H', documentId: 3 });
        expect((await row(target, 201)).documentId).toBeNull();
      });

      it('rejects hidden selections without persisting the source edit', async () => {
        const response = await update({
          name: 'Must not persist',
          [association]: association === 'children' ? [203] : 203,
        });
        expect(response.status).toBe(403);
        expect(response.body).not.toHaveProperty('data');
        expect(await selected(target)).toEqual([205]);
        expect(await row()).toEqual({ id: 3, name: 'Owned', tenantId: 'B', projectId: null });
        expect(await row(target, 203)).toEqual({ id: 203, name: 'Hidden', tenantId: 'C', documentId: null });
      });

      it.each([false, true])(
        'restores the source and foreign keys after a late failure (filtered=%s)',
        async (filtered) => {
          let observed: unknown;
          app.db.getCollection(target).model.addHook('afterUpdate', async (_record, options) => {
            const children = await app.db.getCollection(target).model.findAll({
              where: { id: [201, 205] },
              order: [['id', 'ASC']],
              transaction: options.transaction,
            });
            if (children[0]?.get('documentId') !== 3 || children[1]?.get('documentId') !== null) return;
            const source = await app.db
              .getCollection('documents')
              .model.findByPk(3, { transaction: options.transaction });
            observed = { source: source?.toJSON(), children: children.map((child) => child.toJSON()) };
            throw new Error('HTTP child rollback fixture');
          });
          const values = { name: 'Edited', [association]: selection };
          const response = await (filtered
            ? supertest(app.callback())
                .post('/api/documents:update')
                .query({ filterByTk: 3, filter: JSON.stringify({ name: 'Owned' }) })
                .send(values)
            : update(values));
          expect(response.status).toBe(500);
          expect(response.body).not.toHaveProperty('data');
          expect(observed).toEqual({
            source: { id: 3, name: 'Edited', tenantId: 'B', projectId: null },
            children: [
              { id: 201, name: 'Owned', tenantId: 'B', documentId: 3 },
              { id: 205, name: 'Owned', tenantId: 'B', documentId: null },
            ],
          });
          expect(await row()).toEqual({ id: 3, name: 'Owned', tenantId: 'B', projectId: null });
          expect(await row(target, 201)).toEqual({ id: 201, name: 'Owned', tenantId: 'B', documentId: null });
          expect(await row(target, 205)).toEqual({ id: 205, name: 'Owned', tenantId: 'B', documentId: 3 });
        },
      );
    });

    it('removes the current HasOne child without list permission', async () => {
      await grantChild('profile', 'remove');
      acl.getRole('editor').revokeAction('profiles:view');
      const response = await childRequest('profile', 'remove');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: { keys: [205], affected: 1 } });
      expect(await row('profiles', 205)).toEqual({ id: 205, name: 'Owned', tenantId: 'B', documentId: null });
    });

    it.each([
      ['children', 'children'],
      ['profile', 'profiles'],
    ] as const)('rejects the read placeholder as a %s write source', async (association, target) => {
      await grantChild(association, 'set');
      const response = await childRequest(association, 'set', 201, '_');
      expect(response.status).toBe(400);
      expect(response.body).not.toHaveProperty('data');
      expect(await selected(target)).toEqual([205]);
      expect((await row(target, 201)).documentId).toBeNull();
    });

    it.each([
      { association: 'children', target: 'children', id: undefined },
      { association: 'profile', target: 'profiles', id: 205 },
    ] as const)('rejects invalid remove selectors for $association', async ({ association, target, id }) => {
      await grantChild(association, 'remove');
      const response = await childRequest(association, 'remove', id);
      expect(response.status).toBe(400);
      expect(response.body).not.toHaveProperty('data');
      expect(await selected(target)).toEqual([205]);
    });

    it.skipIf(!coreResourcerEntry)(
      'clears HasMany children with an explicit empty body without list permission',
      async () => {
        await grantChild('children', 'set');
        acl.getRole('editor').revokeAction('children:view');
        const response = await childRequest('children', 'set').send([]);
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ data: { keys: [205], affected: 1 } });
        expect(await row('children', 205)).toEqual({ id: 205, name: 'Owned', tenantId: 'B', documentId: null });
      },
    );
  });

  it.each([
    { operation: 'add', before: [], after: [102] },
    { operation: 'remove', before: [101, 102], after: [101] },
    { operation: 'set', before: [101], after: [102] },
  ] as const)(
    'handles the concrete $operation route without changing the target',
    async ({ operation, before, after }) => {
      await grantLink(operation);
      await seedLinks([...before]);
      const response = await link(operation, [102]);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
      expect(await links()).toEqual(after);
      expect(await row()).toEqual({ id: 3, name: 'Owned', tenantId: 'B', projectId: null });
      expect(await row('projects', 102)).toEqual({ id: 102, name: 'Visible', tenantId: 'H' });
    },
  );

  it.each(['add', 'remove', 'set'] as const)(
    'denies concrete %s on a source that is only visible',
    async (operation) => {
      await grantLink(operation);
      await seedLinks([101], 4);
      const response = await link(operation, [operation === 'remove' ? 101 : 102], 4);
      expect(response.status).toBe(403);
      expect(response.body).not.toHaveProperty('data');
      expect(await links()).toEqual([101]);
      expect(await row('documents', 4)).toEqual({ id: 4, name: 'Visible', tenantId: 'H', projectId: null });
    },
  );

  it.each([
    ['add', 'documents'],
    ['remove', 'documents'],
    ['set', 'documents'],
    ['add', 'projects'],
    ['remove', 'projects'],
    ['set', 'projects'],
  ] as const)('requires the concrete %s grant on %s independently', async (operation, resource) => {
    await grantLink(operation);
    await seedLinks([101]);
    acl.getRole('editor').revokeAction(`${resource}:${operation}`);
    const response = await link(operation, [operation === 'remove' ? 101 : 102]);
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    expect(await links()).toEqual([101]);
  });

  it('retains the independent source action filter on concrete additions', async () => {
    await grantLink('add');
    await grant('documents', 'add', ['projects'], { name: 'Other' });
    const response = await link('add', [102]);
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    expect(await links()).toEqual([]);
  });

  it.each(['remove', 'set'] as const)('checks target action conditions on links removed by %s', async (operation) => {
    await grantLink(operation);
    await grant('projects', operation, ['id'], { id: 102 });
    await seedLinks([101]);
    const response = await link(operation, [operation === 'remove' ? 101 : 102]);
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    expect(await links()).toEqual([101]);
  });

  it('retains the target list scope when adding a visible reference', async () => {
    await grantLink('add');
    await grant('projects', 'view', ['id'], { id: 101 });
    const response = await link('add', [102]);
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    expect(await links()).toEqual([]);
  });

  it.each(['add', 'set'] as const)('rejects hidden additions in concrete %s', async (operation) => {
    await grantLink(operation);
    await seedLinks([101]);
    const response = await link(operation, [102, 103]);
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    expect(await links()).toEqual([101]);
  });

  it('removes an unreadable old target without requiring list permission or changing it', async () => {
    await grantLink('remove');
    await seedLinks([103]);
    acl.getRole('editor').revokeAction('projects:view');
    const response = await supertest(app.callback()).post('/api/documents/3/projects:remove?filterByTk=103');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
    expect(await links()).toEqual([]);
    expect(await row('projects', 103)).toEqual({ id: 103, name: 'Hidden', tenantId: 'C' });
  });

  it('preserves an unchanged unreadable link without requiring list permission', async () => {
    await grantLink('add');
    await seedLinks([103]);
    acl.getRole('editor').revokeAction('projects:view');
    const response = await link('add', [103]);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { keys: [], affected: 0 } });
    expect(await links()).toEqual([103]);
    expect(await row('projects', 103)).toEqual({ id: 103, name: 'Hidden', tenantId: 'C' });
  });

  it.each([undefined, {}])('does not clear links when no target selector was sent: %j', async (body) => {
    await grantLink('set');
    await seedLinks([101, 103]);
    acl.getRole('editor').revokeAction('projects:view');
    const request = supertest(app.callback()).post('/api/documents/3/projects:set');
    const response = await (body === undefined ? request : request.send(body));
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
    expect(await links()).toEqual([101, 103]);
    expect(await app.db.getCollection('projects').model.count()).toBe(3);
  });

  it.skipIf(!!coreResourcerEntry)('retains links when the installed core drops an empty array body', async () => {
    await grantLink('set');
    await seedLinks([101, 103]);
    const response = await link('set', []);
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
    expect(await links()).toEqual([101, 103]);
  });

  describe.skipIf(!coreResourcerEntry)('explicit empty selector transport', () => {
    it('clears links without requiring target list permission or changing the targets', async () => {
      await grantLink('set');
      await seedLinks([101, 103]);
      acl.getRole('editor').revokeAction('projects:view');
      const response = await link('set', []);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
      expect(await links()).toEqual([]);
      expect(await row('projects', 101)).toEqual({ id: 101, name: 'Owned', tenantId: 'B' });
      expect(await row('projects', 103)).toEqual({ id: 103, name: 'Hidden', tenantId: 'C' });
      expect(await app.db.getCollection('projects').model.count()).toBe(3);
    });

    it.each(['documents', 'projects'])('requires the independent set grant on %s to clear links', async (resource) => {
      await grantLink('set');
      await seedLinks([101]);
      acl.getRole('editor').revokeAction(`${resource}:set`);
      const response = await link('set', []);
      expect(response.status).toBe(403);
      expect(response.body).not.toHaveProperty('data');
      expect(await links()).toEqual([101]);
    });

    it('does not clear a source that is only visible', async () => {
      await grantLink('set');
      await seedLinks([101], 4);
      const response = await link('set', [], 4);
      expect(response.status).toBe(403);
      expect(response.body).not.toHaveProperty('data');
      expect(await links()).toEqual([101]);
    });

    it('checks target set conditions on every removed link', async () => {
      await grantLink('set');
      await grant('projects', 'set', ['id'], { id: 101 });
      await seedLinks([101, 103]);
      const response = await link('set', []);
      expect(response.status).toBe(403);
      expect(response.body).not.toHaveProperty('data');
      expect(await links()).toEqual([101, 103]);
    });

    it('rejects an empty body array combined with a query selector', async () => {
      await grantLink('set');
      await seedLinks([101]);
      const response = await supertest(app.callback()).post('/api/documents/3/projects:set?filterByTk=101').send([]);
      expect(response.status).toBe(400);
      expect(response.body).not.toHaveProperty('data');
      expect(await links()).toEqual([101]);
    });

    it('restores cleared links when a post-delete hook fails', async () => {
      await grantLink('set');
      await seedLinks([101, 103]);
      let observed: unknown;
      app.db.getCollection('document_projects').model.addHook('afterBulkDestroy', async (options) => {
        observed = await app.db.getCollection('document_projects').model.count({ transaction: options.transaction });
        throw new Error('HTTP empty set rollback fixture');
      });
      const response = await link('set', []);
      expect(response.status).toBe(500);
      expect(response.body).not.toHaveProperty('data');
      expect(observed).toBe(0);
      expect(await links()).toEqual([101, 103]);
    });
  });

  it('accepts the core array query selector on a concrete set', async () => {
    await grantLink('set');
    const response = await supertest(app.callback()).post(
      '/api/documents/3/projects:set?filterByTks[]=101&filterByTks[]=102',
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
    expect(await links()).toEqual([101, 102]);
  });

  it('rejects competing body and query selectors without changing links', async () => {
    await grantLink('set');
    await seedLinks([101]);
    const response = await supertest(app.callback()).post('/api/documents/3/projects:set?filterByTk=101').send([102]);
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
    expect(await links()).toEqual([101]);
  });

  it('does not treat the read placeholder as a writable concrete source', async () => {
    await grantLink('add');
    const response = await link('add', [102], '_');
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
    expect(await links()).toEqual([]);
  });

  it.each(['documents', 'projects'])('requires concrete action field permissions on %s', async (resource) => {
    await grantLink('add');
    await grant(resource, 'add', ['name']);
    const response = await link('add', [102]);
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
    expect(await links()).toEqual([]);
  });

  it('rolls back removals and insertions when a concrete set hook fails', async () => {
    await grantLink('set');
    await seedLinks([101]);
    let observed: unknown;
    app.db.getCollection('document_projects').model.addHook('afterBulkCreate', async (_records, options) => {
      observed = (
        await app.db.getCollection('document_projects').model.findAll({ transaction: options.transaction })
      ).map((record) => Number(record.get('projectId')));
      throw new Error('HTTP concrete set rollback fixture');
    });
    const response = await link('set', [102]);
    expect(response.status).toBe(500);
    expect(response.body).not.toHaveProperty('data');
    expect(observed).toEqual([102]);
    expect(await links()).toEqual([101]);
    expect(await row('projects', 102)).toEqual({ id: 102, name: 'Visible', tenantId: 'H' });
  });

  it('links a visible-only target without claiming or changing that target', async () => {
    const visible = await app.agent().resource('projects').get({ filterByTk: 102 });
    expect(visible.status).toBe(200);
    expect(visible.body).toEqual({ data: { id: 102, name: 'Visible' } });
    const response = await update({ name: 'Edited', project: 102, projects: [102] });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
    expect(await row()).toEqual({ id: 3, name: 'Edited', tenantId: 'B', projectId: 102 });
    expect(await links()).toEqual([102]);
    expect(await row('projects', 102)).toEqual({ id: 102, name: 'Visible', tenantId: 'H' });
  });

  it.each(['project', 'projects'])('accepts an empty HTTP filter on a root %s reference update', async (name) => {
    const response = await supertest(app.callback())
      .post('/api/documents:update?filterByTk=3&filter=%7B%7D')
      .send({ name: 'Edited', [name]: name === 'project' ? 102 : [102] });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
    expect(await row()).toEqual({ id: 3, name: 'Edited', tenantId: 'B', projectId: name === 'project' ? 102 : null });
    expect(await links()).toEqual(name === 'projects' ? [102] : []);
    expect(await row('projects', 102)).toEqual({ id: 102, name: 'Visible', tenantId: 'H' });
  });

  it.each(['project', 'projects'])('rejects a relational HTTP filter on a root %s reference update', async (name) => {
    const response = await supertest(app.callback())
      .post('/api/documents:update')
      .query({ filterByTk: 3, filter: JSON.stringify({ project: { name: 'Owned' } }) })
      .send({ name: 'Forbidden', [name]: name === 'project' ? 102 : [102] });
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
    expect(await row()).toEqual({ id: 3, name: 'Owned', tenantId: 'B', projectId: null });
    expect(await links()).toEqual([]);
  });

  it('rejects reference edits to a source that is only visible', async () => {
    const visible = await app.agent().resource('documents').get({ filterByTk: 4 });
    expect(visible.body).toEqual({ data: { id: 4, name: 'Visible' } });
    const response = await update({ name: 'Forbidden', project: 101, projects: [101] }, 4);
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    expect(await row('documents', 4)).toEqual({ id: 4, name: 'Visible', tenantId: 'H', projectId: null });
    expect(await links()).toEqual([]);
  });

  it.each([
    { project: 103, projects: [101] },
    { project: 101, projects: [101, 103] },
  ])('rolls back scalar and reference changes when a target is hidden: %j', async (references) => {
    const response = await update({ name: 'Forbidden', ...references });
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    expect(await row()).toEqual({ id: 3, name: 'Owned', tenantId: 'B', projectId: null });
    expect(await links()).toEqual([]);
  });

  it('updates a single belongs-to reference without a join-table mutation', async () => {
    const response = await update({ project: 102 });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
    expect(await row()).toEqual({ id: 3, name: 'Owned', tenantId: 'B', projectId: 102 });
    expect(await links()).toEqual([]);
    expect(await row('projects', 102)).toEqual({ id: 102, name: 'Visible', tenantId: 'H' });
  });

  it('clears existing references without deleting or claiming the targets', async () => {
    expect((await update({ project: 102, projects: [101, 102] })).status).toBe(200);
    const response = await update({ project: null, projects: [] });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
    expect(await row()).toEqual({ id: 3, name: 'Owned', tenantId: 'B', projectId: null });
    expect(await links()).toEqual([]);
    expect(await row('projects', 102)).toEqual({ id: 102, name: 'Visible', tenantId: 'H' });
    expect(await app.db.getCollection('projects').model.count()).toBe(3);
  });

  it.each(['documents:update', 'projects:view'])(
    'preserves the missing operation denial for %s',
    async (permission) => {
      acl.getRole('editor').revokeAction(permission);
      const response = await update({ name: 'Forbidden', project: 102, projects: [102] });
      expect(response.status).toBe(403);
      expect(response.body).not.toHaveProperty('data');
      expect(await row()).toEqual({ id: 3, name: 'Owned', tenantId: 'B', projectId: null });
      expect(await links()).toEqual([]);
    },
  );

  it('retains source role conditions in addition to ownership', async () => {
    await grant('documents', 'update', ['name', 'project', 'projects'], { name: 'Visible' });
    const response = await update({ name: 'Forbidden', project: 102, projects: [102] });
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    expect(await row()).toEqual({ id: 3, name: 'Owned', tenantId: 'B', projectId: null });
    expect(await links()).toEqual([]);
  });

  it('does not let target visibility override its custom role filter', async () => {
    await grant('projects', 'view', ['id', 'name'], { id: 101 });
    const response = await update({ name: 'Forbidden', project: 101, projects: [102] });
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    expect(await row()).toEqual({ id: 3, name: 'Owned', tenantId: 'B', projectId: null });
    expect(await links()).toEqual([]);
  });

  it('links a visible target that satisfies its independent custom role filter', async () => {
    await grant('projects', 'view', ['id', 'name'], { id: 102 });
    const response = await update({ project: 102, projects: [102] });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
    expect(await row()).toEqual({ id: 3, name: 'Owned', tenantId: 'B', projectId: 102 });
    expect(await links()).toEqual([102]);
  });

  it('requires read permission for the referenced target key', async () => {
    await grant('projects', 'view', ['name']);
    const response = await update({ name: 'Forbidden', project: 102 });
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
    expect(await row()).toEqual({ id: 3, name: 'Owned', tenantId: 'B', projectId: null });
  });

  it('requires field permission for every submitted association', async () => {
    await grant('documents', 'update', ['name', 'project']);
    const response = await update({ name: 'Forbidden', project: 101, projects: [102] });
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
    expect(await row()).toEqual({ id: 3, name: 'Owned', tenantId: 'B', projectId: null });
    expect(await links()).toEqual([]);
  });

  it('does not transfer ownership alongside an otherwise permitted reference change', async () => {
    const response = await update({ tenantId: 'C', project: 102, projects: [102] });
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    expect(await row()).toEqual({ id: 3, name: 'Owned', tenantId: 'B', projectId: null });
    expect(await links()).toEqual([]);
  });

  it('rejects nested target edits rather than treating them as reference keys', async () => {
    const response = await update({ name: 'Forbidden', project: { id: 102, name: 'Changed' } });
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
    expect(await row()).toEqual({ id: 3, name: 'Owned', tenantId: 'B', projectId: null });
    expect(await row('projects', 102)).toEqual({ id: 102, name: 'Visible', tenantId: 'H' });
  });

  it('rolls back source edits, removed links and inserted links when a join hook fails', async () => {
    expect((await update({ project: 101, projects: [101] })).status).toBe(200);
    let observed: unknown;
    app.db.getCollection('document_projects').model.addHook('afterBulkCreate', async (_records, options) => {
      observed = {
        source: (
          await app.db.getCollection('documents').model.findByPk(3, { transaction: options.transaction })
        )?.toJSON(),
        links: (
          await app.db.getCollection('document_projects').model.findAll({ transaction: options.transaction })
        ).map((record) => Number(record.get('projectId'))),
      };
      throw new Error('HTTP reference rollback fixture');
    });
    const response = await update({ name: 'Edited', project: 102, projects: [102] });
    expect(response.status).toBe(500);
    expect(response.body).not.toHaveProperty('data');
    expect(observed).toEqual({
      source: { id: 3, name: 'Edited', tenantId: 'B', projectId: 102 },
      links: [102],
    });
    expect(await row()).toEqual({ id: 3, name: 'Owned', tenantId: 'B', projectId: 101 });
    expect(await links()).toEqual([101]);
    expect(await row('projects', 102)).toEqual({ id: 102, name: 'Visible', tenantId: 'H' });
  });
});

import { pathToFileURL } from 'node:url';
import { mockServer, supertest, type MockServer } from '@tachybase/test';
import { ACL, Resourcer, Transaction, type Collection, type Context } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { AccessRootMutationHandler } from '../../access-control/root-mutation-handler';
import type { AccessRootReadContext } from '../../access-control/root-read-context';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_ENTRY;
const coreResourcerEntry = process.env.TENANT_ACCESS_CORE_RESOURCER_ENTRY;
const coreAvailable = coreEntry || 'registerActionParamsResolver' in ACL.prototype;
const actor = { tenantId: 'B', roleName: 'editor', userId: 28 };
const modes = ['single', 'keys', 'matching'] as const;
type Selection = (typeof modes)[number];

/** Real HTTP and independent PostgreSQL connections; fixture identity is server-supplied. */
describe.skipIf(!postgresUrl || !coreAvailable)('concurrent relational-filtered HTTP deletion', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;
  const identity = (collection: Collection) => ({
    ...mainIdentity,
    collectionName: collection.name,
    collectionKey: `${collection.name}-key`,
  });
  const identities = () => ['documents', 'projects'].map((name) => identity(app.db.getCollection(name)));

  beforeEach(async () => {
    const isolated = isolatedPostgresDatabase(postgresUrl!);
    const database = isolated.options;
    await isolated.close();
    app = mockServer({ acl: false, registerActions: true, database, resourcer: { prefix: '/api' } });
    if (coreResourcerEntry) {
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
          { name: 'id', type: 'integer', primaryKey: true },
          { name: 'name', type: 'string' },
          { name: 'tenantId', type: 'string' },
        ],
      });
    const docs = db.getCollection('documents');
    docs.setField('project', { type: 'belongsTo', target: 'projects', foreignKey: 'projectId', onDelete: 'RESTRICT' });
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
    await db.getRepository('collections').create({ values: { name: 'projects', key: 'projects-key' } });
    const store = new AccessConfigStore(db, (source) =>
      resolveModelMetadata(db.getCollection(source.collectionName), {
        resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
      }),
    );
    const source = configFor(ownerCondition);
    source.rules.push({ ...configFor({ type: 'constant', value: true }, 'visibility').rules[0], id: 'visible' });
    await store.save(identity(docs), { ...source, revision: 0 }, { userId: 28 });
    await store.save(
      identity(db.getCollection('projects')),
      {
        ...configFor(
          {
            type: 'compare',
            operator: 'eq',
            left: { type: 'field', path: 'name' },
            right: { type: 'literal', value: 'Visible' },
          },
          'visibility',
        ),
        revision: 0,
      },
      { userId: 28 },
    );
    await db.getCollection('projects').model.create({ id: 102, name: 'Visible', tenantId: 'H' });
    await docs.model.bulkCreate([
      { id: 3, name: 'Owned', tenantId: 'B', projectId: 102 },
      { id: 4, name: 'Visible', tenantId: 'H', projectId: 102 },
      { id: 7, name: 'Owned', tenantId: 'B', projectId: 102 },
    ]);
    const CoreACL = coreEntry ? (await import(/* @vite-ignore */ pathToFileURL(coreEntry).href)).ACL : ACL;
    const acl: ACL = new CoreACL();
    app.mainDataSource.acl = acl;
    acl.setAvailableAction('view', { aliases: ['list', 'get'] });
    acl.setAvailableAction('destroy', {});
    const role = acl.define({ role: actor.roleName });
    role.grantAction('documents:view', { fields: ['id', 'name'], appends: ['project'] });
    role.grantAction('projects:view', { fields: ['id', 'name'] });
    role.grantAction('documents:destroy', {});
    const adapter = new AccessAclScopeAdapter(acl, 'main', store, db);
    unregister = adapter.register();
    const writer = new AccessRootMutationHandler(
      db,
      adapter,
      new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection))),
      identity,
    );
    app.resourcer.use(
      async (ctx, next) => {
        Object.assign(ctx.state, {
          currentRole: actor.roleName,
          currentUser: { id: actor.userId },
          currentTenant: { id: actor.tenantId },
        });
        await adapter.prepare(ctx, identities());
        try {
          await next();
        } finally {
          adapter.release(ctx);
        }
      },
      { tag: 'delete-access-preparation', after: 'auth' },
    );
    app.resourcer.use(acl.middleware(), { tag: 'delete-access-acl', after: 'delete-access-preparation' });
    app.resourcer.registerActionHandler('documents:destroy', async (resourceContext) => {
      const ctx = resourceContext as Context & { permission: unknown };
      if (!('permission' in ctx)) throw new Error('ACL middleware did not finalize the request');
      const related: AccessRootReadContext[] = [];
      try {
        await writer.handle(ctx, actor, async (collection) => {
          const resourcer = new Resourcer();
          resourcer.define({ name: collection.name, actions: { list: {} } });
          const action = resourcer.getAction(collection.name, 'list').clone();
          Object.assign(action, { resourceName: collection.name, actionName: 'list' });
          action.mergeParams({ resourceName: collection.name, actionName: 'list', filterByTk: undefined });
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
        });
      } finally {
        for (const decision of related) adapter.release(decision);
      }
    });
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

  const keysFor = (mode: Selection) => (mode === 'single' ? [3] : [3, 7]);
  const request = (mode: Selection, filter: object = { project: { name: 'Visible' } }) =>
    supertest(app.callback())
      .post('/api/documents:destroy')
      .query({
        ...(mode === 'matching' ? {} : { filterByTk: mode === 'single' ? 3 : [3, 7] }),
        filter: JSON.stringify(filter),
      });
  const rows = async () =>
    (await app.db.getCollection('documents').model.findAll({ order: [['id', 'ASC']] })).map((row) => row.toJSON());
  const original = [
    { id: 3, name: 'Owned', tenantId: 'B', projectId: 102 },
    { id: 4, name: 'Visible', tenantId: 'H', projectId: 102 },
    { id: 7, name: 'Owned', tenantId: 'B', projectId: 102 },
  ];

  it.each(modes)('commits a %s deletion without deleting a V-only source', async (mode) => {
    let notifications = 0;
    app.db.getCollection('documents').model.addHook('afterDestroy', (_row, options) => {
      options.transaction.afterCommit(() => {
        notifications++;
      });
    });
    const response = await request(mode);
    expect(response.status).toBe(200);
    const keys = keysFor(mode);
    expect(response.body).toEqual({ data: { keys, affected: keys.length } });
    expect(await rows()).toEqual(mode === 'single' ? [original[1], original[2]] : [original[1]]);
    expect(notifications).toBe(keys.length);
    expect((await app.db.getCollection('projects').model.findByPk(102))?.get('name')).toBe('Visible');
  });

  describe.each([
    ['exists', 'verification'],
    ['not-exists', 'verification'],
    ['exists', 'commit'],
    ['not-exists', 'commit'],
  ] as const)('%s filter at %s', (existence, stage) => {
    it.each(modes)('rolls back all actual %s deletes after an inconsistent concurrent change', async (mode) => {
      const db = app.db;
      const docs = db.getCollection('documents');
      const projects = db.getCollection('projects');
      const keys = keysFor(mode);
      const filter = existence === 'exists' ? { project: { name: 'Visible' } } : { 'project.$notExists': true };
      const nextName = existence === 'exists' ? 'Revoked' : 'Visible';
      if (existence === 'not-exists') await projects.model.update({ name: 'Hidden' }, { where: { id: 102 } });
      const competitor = isolatedPostgresDatabase(postgresUrl!);
      const quote = db.sequelize.getQueryInterface().queryGenerator;
      const table = quote.quoteTable(docs.model.getTableName());
      const target = quote.quoteTable(projects.model.getTableName());
      const deleted: number[] = [];
      let notifications = 0;
      let interference = 0;
      let commitAttempts = 0;
      let commitErrorCode: string | undefined;
      let restoreCommit: (() => void) | undefined;
      const interfere = async (writeTransaction: Transaction) => {
        expect(await docs.model.findAll({ where: { id: keys }, transaction: writeTransaction })).toEqual([]);
        interference++;
        await competitor.sequelize.transaction(
          { isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE },
          async (transaction) => {
            await competitor.sequelize.query("SET LOCAL statement_timeout = '10s'", { transaction });
            const [before] = await competitor.sequelize.query(
              `SELECT id FROM ${table} WHERE id = ANY($keys) ORDER BY id`,
              { bind: { keys }, transaction },
            );
            expect(before).toEqual(keys.map((id) => ({ id })));
            await competitor.sequelize.query(`UPDATE ${target} SET name = $name WHERE id = 102`, {
              bind: { name: nextName },
              transaction,
            });
          },
        );
      };
      docs.model.addHook('afterDestroy', 'concurrent-delete', async (record, options) => {
        deleted.push(Number(record.get('id')));
        options.transaction.afterCommit(() => {
          notifications++;
        });
        if (record.get('id') !== keys[keys.length - 1]) return;
        if (stage === 'verification') await interfere(options.transaction);
        else {
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
        }
      });
      try {
        const response = await request(mode, filter);
        expect(response.status).toBe(409);
        expect(response.body).not.toHaveProperty('data');
        expect(deleted).toEqual(keys);
        expect(interference).toBe(1);
        if (stage === 'commit') {
          expect(commitAttempts).toBe(1);
          expect(commitErrorCode).toBe('40001');
        }
        expect(notifications).toBe(0);
        expect(await rows()).toEqual(original);
        expect((await projects.model.findByPk(102))?.get('name')).toBe(nextName);
        const retry = await request(mode, filter);
        expect(retry.status).toBe(mode === 'matching' ? 200 : 403);
        if (mode === 'matching') expect(retry.body).toEqual({ data: { keys: [], affected: 0 } });
        else expect(retry.body).not.toHaveProperty('data');
        expect(deleted).toEqual(keys);
        expect(await rows()).toEqual(original);
      } finally {
        docs.model.removeHook('afterDestroy', 'concurrent-delete');
        restoreCommit?.();
        await competitor.close();
      }
    });
  });

  it('allows a legal serial order when the changer does not read deleted sources', async () => {
    const db = app.db;
    const competitor = isolatedPostgresDatabase(postgresUrl!);
    const table = db.sequelize
      .getQueryInterface()
      .queryGenerator.quoteTable(db.getCollection('projects').model.getTableName());
    let notifications = 0;
    let deleted = 0;
    db.getCollection('documents').model.addHook('afterDestroy', 'legal-delete', async (_record, options) => {
      deleted++;
      options.transaction.afterCommit(() => {
        notifications++;
      });
      await competitor.sequelize.transaction(
        { isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE },
        async (transaction) => {
          await competitor.sequelize.query("SET LOCAL statement_timeout = '10s'", { transaction });
          await competitor.sequelize.query(`UPDATE ${table} SET name = 'Revoked' WHERE id = 102`, { transaction });
        },
      );
    });
    try {
      const response = await request('single');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
      expect(await rows()).toEqual([original[1], original[2]]);
      expect((await db.getCollection('projects').model.findByPk(102))?.get('name')).toBe('Revoked');
      expect(deleted).toBe(1);
      expect(notifications).toBe(1);
    } finally {
      db.getCollection('documents').model.removeHook('afterDestroy', 'legal-delete');
      await competitor.close();
    }
  });
});

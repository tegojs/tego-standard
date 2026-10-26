import { pathToFileURL } from 'node:url';
import { mockServer, supertest, type MockServer } from '@tachybase/test';
import { ACL, Application, Resourcer, type Collection, type Context } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore, registerAccessConfigGuards } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { AccessRootMutationHandler } from '../../access-control/root-mutation-handler';
import type { AccessRootReadContext } from '../../access-control/root-read-context';
import { AccessRootReadHandler } from '../../access-control/root-read-handler';
import { seedAclScopes } from './acl-database';
import { mainIdentity, registerConfigModels, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_ENTRY;
const coreResourcerEntry = process.env.TENANT_ACCESS_CORE_RESOURCER_ENTRY;
const coreAvailable = coreEntry || 'registerActionParamsResolver' in ACL.prototype;
const actor = { tenantId: 'B', roleName: 'editor', userId: 28 };
const expectedRows = [{ id: 3 }, { id: 4 }, { id: 7 }];

function barrier() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    enteredWhile: (pending: PromiseLike<unknown>) =>
      Promise.race([
        entered,
        Promise.resolve(pending).then(() => {
          throw new Error('Operation finished before reaching the expected barrier');
        }),
      ]),
    wait: async () => {
      enter();
      await held;
    },
  };
}

describe('access HTTP publication barrier', () => {
  it.each(['completed', 'rejected'])('does not wait forever when the operation has already %s', async (mode) => {
    const gate = barrier();
    const error = new Error('Operation failed before the barrier');
    const pending = mode === 'completed' ? Promise.resolve() : Promise.reject(error);
    void pending.catch(() => {});
    let result: unknown;
    const waiting = gate.enteredWhile(pending).then(
      () => {
        result = 'resolved';
      },
      (failure) => {
        result = failure;
      },
    );
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (mode === 'rejected') expect(result).toBe(error);
      else expect(result).toMatchObject({ message: expect.stringContaining('finished before') });
    } finally {
      gate.release();
      await gate.wait();
      await waiting;
    }
  });
});

/** Independent application state/pools, actual ACL and HTTP; authenticated fixture identity only. */
describe.skipIf(!postgresUrl || !coreAvailable)('access config publication across HTTP applications', () => {
  type Fixture = Awaited<ReturnType<typeof createFixture>>;
  let first: Fixture;
  let second: Fixture;
  const apps: MockServer[] = [];
  const cleanup: Array<() => void> = [];

  async function createFixture(initialize: boolean) {
    const isolated = isolatedPostgresDatabase(postgresUrl!);
    const database = isolated.options;
    await isolated.close();
    const app = mockServer({
      name: initialize ? 'access-config-first' : 'access-config-second',
      acl: false,
      registerActions: true,
      database,
      resourcer: { prefix: '/api' },
    });
    apps.push(app);
    if (coreResourcerEntry) {
      const { Resourcer: CoreResourcer } = await import(/* @vite-ignore */ pathToFileURL(coreResourcerEntry).href);
      app.resourcer.restApiMiddleware = CoreResourcer.prototype.restApiMiddleware;
    }
    const db = app.db;
    if (initialize) await seedConfigStore(db);
    else registerConfigModels(db);
    await seedAclScopes(db);
    const docs = db.collection({
      name: 'documents',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'name', type: 'string' },
        { name: 'tenantId', type: 'string' },
      ],
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
    if (initialize) {
      await db.sync();
      await db.getCollection('tenants').model.create({ id: 'B', enabled: true });
      await docs.model.bulkCreate([
        { id: 3, name: 'Owned', tenantId: 'B' },
        { id: 4, name: 'Visible', tenantId: 'H' },
        { id: 7, name: 'Owned', tenantId: 'B' },
      ]);
    }
    registerAccessConfigGuards(db);
    const store = new AccessConfigStore(db, (source) =>
      resolveModelMetadata(db.getCollection(source.collectionName), {
        resolveCollectionKey: () => accessCollectionKey(mainIdentity),
      }),
    );
    if (initialize) {
      const initial = configFor(ownerCondition);
      initial.rules.push({ ...configFor({ type: 'constant', value: true }, 'visibility').rules[0], id: 'visible' });
      await store.save(mainIdentity, { ...initial, revision: 0 }, { userId: 28 });
    }
    const CoreACL = coreEntry ? (await import(/* @vite-ignore */ pathToFileURL(coreEntry).href)).ACL : ACL;
    const acl: ACL = new CoreACL();
    app.mainDataSource.acl = acl;
    acl.setAvailableAction('view', { aliases: ['list', 'get', 'count'] });
    acl.setAvailableAction('update', {});
    const role = acl.define({ role: actor.roleName });
    role.grantAction('documents:view', { fields: ['id', 'name'] });
    role.grantAction('documents:update', { fields: ['name'] });
    const adapter = new AccessAclScopeAdapter(acl, 'main', store, db);
    cleanup.push(adapter.register());
    const resolveIdentity = (collection: Collection) => (collection === docs ? mainIdentity : undefined);
    const queries = new AccessQueryService(db, adapter, () => accessCollectionKey(mainIdentity));
    const reader = new AccessRootReadHandler(db, adapter, queries, resolveIdentity);
    const writer = new AccessRootMutationHandler(db, adapter, queries, resolveIdentity);
    const control: { afterPrepare?: () => Promise<void> } = {};
    app.resourcer.use(
      async (ctx, next) => {
        Object.assign(ctx.state, {
          currentRole: actor.roleName,
          currentUser: { id: actor.userId },
          currentTenant: { id: actor.tenantId },
        });
        await adapter.prepare(ctx, [mainIdentity]);
        try {
          const afterPrepare = control.afterPrepare;
          control.afterPrepare = undefined;
          await afterPrepare?.();
          await next();
        } finally {
          adapter.release(ctx);
        }
      },
      { tag: 'config-publication-preparation', after: 'auth' },
    );
    app.resourcer.use(acl.middleware(), { tag: 'config-publication-acl', after: 'config-publication-preparation' });
    app.resourcer.define({
      name: 'documents',
      actions: Object.fromEntries(
        ['list', 'count'].map((actionName) => [
          actionName,
          async (ctx: Context & { permission: unknown }) => {
            if (!('permission' in ctx)) throw new Error('ACL middleware did not finalize this request');
            await reader.handleResourceWithRelatedContexts(ctx, actor, async () => null);
          },
        ]),
      ),
    });
    app.resourcer.registerActionHandler('documents:update', async (resourceContext) => {
      const ctx = resourceContext as Context & { permission: unknown };
      if (!('permission' in ctx)) throw new Error('ACL middleware did not finalize this request');
      const related: AccessRootReadContext[] = [];
      try {
        await writer.handle(ctx, actor, async () => {
          const resourcer = new Resourcer();
          resourcer.define({ name: 'documents', actions: { list: {} } });
          const action = resourcer.getAction('documents', 'list').clone();
          Object.assign(action, { resourceName: 'documents', actionName: 'list' });
          action.mergeParams({ resourceName: 'documents', actionName: 'list', filterByTk: undefined });
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
          await adapter.prepare(decision, [mainIdentity]);
          await acl.middleware()(decision as never, async () => {});
          return decision;
        });
      } finally {
        for (const decision of related) adapter.release(decision);
      }
    });
    return { app, store, control };
  }

  beforeEach(async () => {
    first = await createFixture(true);
    second = await createFixture(false);
  });
  afterEach(async () => {
    for (const unregister of cleanup.splice(0)) unregister();
    const opened = apps.splice(0);
    try {
      await opened[0]?.db.sequelize.drop({ cascade: true });
    } finally {
      // MockServer.destroy resets the global supervisor; close peers before that shared cleanup.
      try {
        for (const app of opened.slice(1)) await Application.prototype.destroy.call(app);
      } finally {
        await opened[0]?.destroy();
      }
    }
  });

  const list = (fixture: Fixture) =>
    supertest(fixture.app.callback())
      .get('/api/documents:list')
      .query({ 'fields[]': ['id'], sort: 'id' });
  const count = (fixture: Fixture) => supertest(fixture.app.callback()).get('/api/documents:count');
  const update = (fixture: Fixture, id = 3) =>
    supertest(fixture.app.callback()).post('/api/documents:update').query({ filterByTk: id }).send({ name: 'Changed' });
  async function assertReads(fixture: Fixture, rows: Array<{ id: number }>) {
    const response = await list(fixture);
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(rows);
    expect(response.body.meta.count).toBe(rows.length);
    const counted = await count(fixture);
    expect(counted.status).toBe(200);
    expect(counted.body).toEqual({ data: rows.length });
  }
  async function denyWrites(fixture: Fixture) {
    const response = await update(fixture);
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
  }
  async function saveEmpty(fixture: Fixture) {
    const current = (await fixture.store.read(mainIdentity))!;
    return fixture.store.save(mainIdentity, { ...current, rules: [] }, { userId: 16 });
  }

  it.each(['first', 'second'])('publishes a %s-instance save to new requests on both instances', async (publisher) => {
    for (const fixture of [first, second]) await assertReads(fixture, expectedRows);
    const saved = await saveEmpty(publisher === 'first' ? first : second);
    expect(saved.revision).toBe(2);
    for (const fixture of [first, second]) {
      await assertReads(fixture, []);
      await denyWrites(fixture);
      expect(await fixture.store.read(mainIdentity)).toEqual(saved);
      expect(await fixture.app.db.getRepository('tenantAccessRevisions').count()).toBe(2);
    }
  });

  it.each(['read', 'write'])(
    'keeps an already prepared %s on its captured revision while new requests use the new one',
    async (operation) => {
      const gate = barrier();
      first.control.afterPrepare = gate.wait;
      const pending = (operation === 'read' ? list(first) : update(first)).then((response) => response);
      try {
        await gate.enteredWhile(pending);
        await saveEmpty(second);
        for (const fixture of [first, second]) {
          await assertReads(fixture, []);
          await denyWrites(fixture);
        }
      } finally {
        gate.release();
        await pending;
      }
      const response = await pending;
      expect(response.status).toBe(200);
      expect(operation === 'read' ? response.body.data : response.body).toEqual(
        operation === 'read' ? expectedRows : { data: { keys: [3], affected: 1 } },
      );
      expect((await first.app.db.getCollection('documents').model.findByPk(3))?.get('name')).toBe(
        operation === 'read' ? 'Owned' : 'Changed',
      );
      await denyWrites(first);
    },
  );

  it('does not publish uncommitted rules to either HTTP instance', async () => {
    const gate = barrier();
    first.app.db.on('collections.afterUpdateWithAssociations', gate.wait);
    const pending = saveEmpty(first);
    try {
      await gate.enteredWhile(pending);
      for (const fixture of [first, second]) await assertReads(fixture, expectedRows);
      expect((await second.store.read(mainIdentity))?.revision).toBe(1);
    } finally {
      gate.release();
      await pending;
    }
    for (const fixture of [first, second]) await assertReads(fixture, []);
  });

  it('keeps both instances on the previous rules after a persisted config save rolls back', async () => {
    const error = new Error('Configuration publication rollback fixture');
    let observed: unknown;
    first.app.db.on('collections.afterUpdateWithAssociations', async (_record, options) => {
      const row = await first.app.db
        .getCollection('collections')
        .model.findOne({ where: { key: 'documents-key' }, transaction: options.transaction });
      observed = row?.get('options').tenantAccess;
      throw error;
    });
    await expect(saveEmpty(first)).rejects.toBe(error);
    expect(observed).toMatchObject({ revision: 2, rules: [] });
    for (const fixture of [first, second]) {
      await assertReads(fixture, expectedRows);
      expect((await fixture.store.read(mainIdentity))?.revision).toBe(1);
      expect(await fixture.app.db.getRepository('tenantAccessRevisions').count()).toBe(1);
    }
    const response = await update(second);
    expect(response.status).toBe(200);
    expect((await first.app.db.getCollection('documents').model.findByPk(3))?.get('name')).toBe('Changed');
  });

  it('retains visibility but revokes writes on both instances when G is changed to V', async () => {
    const before = await update(first, 7);
    expect(before.status).toBe(200);
    const current = (await second.store.read(mainIdentity))!;
    await second.store.save(
      mainIdentity,
      { ...current, rules: current.rules.filter((rule) => rule.category === 'visibility') },
      { userId: 16 },
    );
    for (const fixture of [first, second]) {
      await assertReads(fixture, expectedRows);
      await denyWrites(fixture);
    }
    expect((await first.app.db.getCollection('documents').model.findByPk(3))?.get('name')).toBe('Owned');
    expect((await second.app.db.getCollection('documents').model.findByPk(7))?.get('name')).toBe('Changed');
  });
});

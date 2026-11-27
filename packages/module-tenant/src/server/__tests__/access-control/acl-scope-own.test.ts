import { ACL, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { grantStoredScope, seedAclScopes } from './acl-database';
import { configStore, initialConfig, mainIdentity, seedConfigStore } from './config-database';
import { sqliteDatabase } from './database';

describe('prepared native own scope finalization', () => {
  let db: Database;
  let acl: ACL;
  let adapter: AccessAclScopeAdapter;
  let store: ReturnType<typeof configStore>;
  const creatorFilter = { createdById: '{{ ctx.state.currentUser.id }}' };

  beforeEach(async () => {
    db = sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    db.collection({
      name: 'documents',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'name', type: 'string' },
        { name: 'createdById', type: 'integer' },
      ],
    });
    await db.sync();
    store = configStore(db);
    acl = new ACL();
    await grantStoredScope(db, acl, { key: 'own', scope: creatorFilter });
    adapter = new AccessAclScopeAdapter(acl, 'main', store, db);
  });

  afterEach(async () => {
    await db.close();
  });

  const params = () => acl.getRole('member').getActionParams('documents:list');
  const args = (ctx: object) => ({
    acl,
    role: 'member',
    resource: 'documents',
    action: 'list',
    source: 'resource' as const,
    ctx,
  });
  async function prepare() {
    await store.save(mainIdentity, initialConfig(), { userId: 28 });
    const ctx = {};
    await adapter.prepare(ctx, [mainIdentity]);
    return ctx;
  }

  it('consumes only the redundant marker and preserves the creator filter and fields without mutating the role', async () => {
    const ctx = await prepare();
    expect(adapter.resolve(args(ctx), structuredClone(params()))).toEqual({
      fields: ['id', 'name'],
      filter: { createdById: '{{ ctx.state.currentUser.id }}' },
    });
    expect(params()).toEqual({
      own: true,
      fields: ['id', 'name'],
      filter: { createdById: '{{ ctx.state.currentUser.id }}' },
    });
  });

  it('retains own on unselected, unprepared and released request phases', async () => {
    const ctx = {};
    await adapter.prepare(ctx, [mainIdentity]);
    expect(adapter.resolve(args(ctx), params())).toEqual(params());
    const selected = await prepare();
    expect(adapter.resolve(args({}), params())).toEqual(params());
    adapter.release(selected);
    expect(adapter.resolve(args(selected), params())).toEqual(params());
  });

  it('does not trust the same creator filter after a manual re-grant', async () => {
    const ctx = await prepare();
    acl.getRole('member').grantAction('documents:view', structuredClone(params()));
    expect(adapter.resolve(args(ctx), params())).toEqual(params());
    expect(params().own).toBe(true);
  });

  it.each([
    { filter: { createdById: '{{ ctx.state.currentUser.id }}', active: true }, own: true },
    { filter: {}, own: true },
    { own: true },
    { filter: { createdById: '{{ ctx.state.currentUser.id }}' }, own: false },
  ])('retains parameters changed by an earlier resolver: %j', async (changed) => {
    const ctx = await prepare();
    const input = { ...params(), ...changed };
    if (!Object.hasOwn(changed, 'filter')) delete input.filter;
    expect(adapter.resolve(args(ctx), input)).toEqual(input);
  });

  it('does not finalize own if core would discard a missing creator field', async () => {
    const ctx = await prepare();
    db.getCollection('documents').removeField('createdById');
    expect(adapter.resolve(args(ctx), params())).toEqual(params());
    expect(params().own).toBe(true);
  });

  it.each(['configuration', 'completion'] as const)(
    'rejects creator metadata removed after finalization at phase %s',
    async (boundary) => {
      await store.save(mainIdentity, initialConfig(), { userId: 28 });
      const ctx = {};
      const consume = () => {
        const finalized = adapter.resolve(args(ctx), structuredClone(params()));
        expect(finalized.own).toBeUndefined();
        expect(finalized.filter).toEqual({ createdById: '{{ ctx.state.currentUser.id }}' });
        db.getCollection('documents').removeField('createdById');
        if (boundary === 'configuration') adapter.configuration(ctx, mainIdentity);
      };
      if (boundary === 'completion') {
        await expect(adapter.withPrepared(ctx, [mainIdentity], consume)).rejects.toThrow();
      } else {
        await adapter.prepare(ctx, [mainIdentity]);
        expect(consume).toThrow();
      }
    },
  );

  it.each([
    { resourceName: 'documents' },
    { dataSourceKey: 'external' },
    { scope: { createdById: '{{ ctx.state.currentUser.id }}', active: true } },
  ])('does not consume non-native scope metadata: %j', async (changed) => {
    await grantStoredScope(db, acl, { key: 'own', scope: creatorFilter, ...changed });
    const ctx = await prepare();
    expect(adapter.resolve(args(ctx), params())).toEqual(params());
    expect(params().own).toBe(true);
  });

  it('does not consume strategy, foreign ACL or foreign data-source own markers', async () => {
    const ctx = await prepare();
    expect(adapter.resolve({ ...args(ctx), source: 'strategy' }, params())).toEqual(params());
    expect(adapter.resolve({ ...args(ctx), acl: new ACL() }, params())).toEqual(params());
    const external = new AccessAclScopeAdapter(acl, 'external', store, db);
    expect(external.resolve(args(ctx), params())).toEqual(params());
  });
});

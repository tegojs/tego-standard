import type { Collection, Database } from '@tego/server';

import { resolveResourceReadRoute } from '../../access-control/resource-read-routing';
import { sqliteDatabase } from './database';

describe('internal resource read routing', () => {
  let db: Database;
  let source: Collection;
  let target: Collection;
  const identity = { dataSourceKey: 'main', collectionKey: 'target-key', collectionName: 'targets' };
  const sourceIdentity = { ...identity, collectionKey: 'source-key', collectionName: 'sources' };
  const resolveIdentity = vi.fn((collection: Collection) => (collection === target ? { ...identity } : undefined));
  const resolveConcreteIdentity = (collection: Collection) =>
    collection === source ? { ...sourceIdentity } : resolveIdentity(collection);
  beforeEach(() => {
    db = sqliteDatabase();
    source = db.collection({ name: 'sources', fields: [{ name: 'name', type: 'string' }] });
    target = db.collection({ name: 'targets', fields: [{ name: 'name', type: 'string' }] });
    source.setField('parent', { type: 'belongsTo', target: 'targets' });
    source.setField('children', { type: 'hasMany', target: 'targets' });
    source.setField('single', { type: 'hasOne', target: 'targets' });
    source.setField('links', { type: 'belongsToMany', target: 'targets', through: 'source_targets' });
    resolveIdentity.mockClear();
  });
  afterEach(async () => {
    await db.close();
  });
  it.each(['list', 'get', 'count', 'sum'])('selects a root target for %s', (actionName) => {
    const route = resolveResourceReadRoute(db, resolveIdentity, { resourceName: 'targets', actionName });
    expect(route.identity).toEqual(identity);
    expect(route.kind).toBe('direct');
    expect(route.actionName).toBe(actionName);
    expect(() => route.assertCurrent()).not.toThrow();
  });
  it.each(['parent', 'children', 'single', 'links'])(
    'selects the actual %s target without resolving source authorization',
    (association) => {
      for (const actionName of ['list', 'get']) {
        const route = resolveResourceReadRoute(db, resolveIdentity, {
          resourceName: `sources.${association}`,
          sourceId: '_',
          actionName,
        });
        expect(route.identity).toEqual(identity);
        expect(route.kind).toBe('direct');
        expect(() => route.assertCurrent()).not.toThrow();
      }
      expect(resolveIdentity.mock.calls.every(([collection]) => collection === target)).toBe(true);
    },
  );
  it.each([
    ['children', 'list', 1],
    ['children', 'get', '1'],
    ['single', 'get', 1],
    ['parent', 'get', 1],
  ] as const)('selects a concrete %s %s source (%j)', (association, actionName, sourceId) => {
    const route = resolveResourceReadRoute(db, resolveConcreteIdentity, {
      resourceName: `sources.${association}`,
      actionName,
      sourceId,
    });
    expect(route).toMatchObject({
      kind: 'association',
      identity: sourceIdentity,
      actionName,
      association: { association, sourceKey: sourceId },
    });
    expect(Object.isFrozen(route)).toBe(true);
    expect(Object.isFrozen(route.identity)).toBe(true);
    if (route.kind !== 'association') throw new Error('Expected an association route');
    expect(Object.isFrozen(route.association)).toBe(true);
    expect(() => route.assertCurrent()).not.toThrow();
  });

  it.each([undefined, null, '', [], {}, true, 1.5, NaN, Infinity, 'x'.repeat(513)])(
    'rejects an unsupported concrete source key %j',
    (sourceId) => {
      expect(() =>
        resolveResourceReadRoute(db, resolveConcreteIdentity, {
          resourceName: 'sources.children',
          actionName: 'list',
          sourceId,
        }),
      ).toThrow();
    },
  );

  it('requires independent source and target identities from the same data source', () => {
    const action = { resourceName: 'sources.children', sourceId: 1, actionName: 'list' };
    for (const value of [
      undefined,
      { ...sourceIdentity, collectionName: 'targets' },
      { ...sourceIdentity, dataSourceKey: 'external' },
    ])
      expect(() =>
        resolveResourceReadRoute(
          db,
          (collection) => (collection === source ? value : resolveIdentity(collection)),
          action,
        ),
      ).toThrow();
    expect(() =>
      resolveResourceReadRoute(db, (collection) => (collection === source ? sourceIdentity : undefined), action),
    ).toThrow();
  });

  it('captures the concrete source descriptor and rechecks both persistent identities', () => {
    const action = { resourceName: 'sources.children', sourceId: '1', actionName: 'list' };
    const mutableSource = { ...sourceIdentity };
    const mutableTarget = { ...identity };
    const route = resolveResourceReadRoute(
      db,
      (collection) => (collection === source ? mutableSource : mutableTarget),
      action,
    );
    action.sourceId = '_';
    action.resourceName = 'sources.single';
    action.actionName = 'get';
    expect(route).toMatchObject({ association: { association: 'children', sourceKey: '1' }, actionName: 'list' });
    mutableSource.collectionKey = 'recreated-source';
    expect(() => route.assertCurrent()).toThrow(/source identity changed/);
    mutableSource.collectionKey = sourceIdentity.collectionKey;
    mutableTarget.collectionKey = 'recreated-target';
    expect(() => route.assertCurrent()).toThrow(/identity changed/);
  });

  it('does not route unsupported concrete associations or actions to a direct target', () => {
    for (const [association, actionName] of [
      ['parent', 'list'],
      ['links', 'get'],
      ['single', 'list'],
      ['children', 'count'],
      ['children', 'sum'],
    ])
      expect(() =>
        resolveResourceReadRoute(db, resolveConcreteIdentity, {
          resourceName: `sources.${association}`,
          sourceId: 1,
          actionName,
        }),
      ).toThrow();
  });
  it.each([
    { resourceName: 'sources.parent', actionName: 'get' },
    { resourceName: 'targets', sourceId: '_', actionName: 'list' },
    { resourceName: 'sources.parent', sourceId: 1, actionName: 'get' },
    { resourceName: 'sources.parent', sourceId: '1', actionName: 'list' },
    { resourceName: 'targets', sourceId: 0, actionName: 'list' },
    { resourceName: 'targets', sourceId: '', actionName: 'list' },
    { resourceName: 'targets', sourceId: null, actionName: 'list' },
    { resourceName: 'sources.parent', sourceId: '_', actionName: 'count' },
    { resourceName: 'sources.parent', sourceId: '_', actionName: 'sum' },
    { resourceName: 'targets', actionName: 'update' },
    { resourceName: 'targets', actionName: 'aggregate' },
    { resourceName: 'targets', actionName: 'list', tenantId: 'B' },
    { resourceName: 'targets', actionName: 'list', params: {} },
  ])('rejects an unsupported action descriptor %j', (action) => {
    expect(() => resolveResourceReadRoute(db, resolveIdentity, action)).toThrow();
  });
  it.each([
    '',
    'targets.',
    '.targets',
    'sources.parent.name',
    'sources._.parent',
    'sources/name',
    'sources:parent',
    'x'.repeat(256),
    'missing',
    'missing.parent',
    'sources.missing',
    'sources.name',
    'sources.__proto__',
  ])('rejects an invalid or unregistered resource %s', (resourceName) => {
    expect(() =>
      resolveResourceReadRoute(db, resolveIdentity, {
        resourceName,
        ...(resourceName.includes('.') ? { sourceId: '_' } : {}),
        actionName: 'get',
      }),
    ).toThrow();
  });
  it('captures non-enumerable data properties and ignores later descriptor changes', () => {
    const action = Object.defineProperty({ actionName: 'list' }, 'resourceName', {
      value: 'targets',
      configurable: true,
    });
    const route = resolveResourceReadRoute(db, resolveIdentity, action);
    Object.defineProperty(action, 'resourceName', { value: 'sources' });
    expect(route.identity).toEqual(identity);
    expect(route.actionName).toBe('list');
    expect(() => route.assertCurrent()).not.toThrow();
  });
  it('rejects input accessors and symbols without invoking them', () => {
    const getter = vi.fn(() => 'targets');
    for (const key of ['resourceName', 'actionName', 'sourceId']) {
      const action = Object.defineProperty({ resourceName: 'targets', actionName: 'get' }, key, { get: getter });
      expect(() => resolveResourceReadRoute(db, resolveIdentity, action)).toThrow();
    }
    for (const action of [
      null,
      [],
      new Date(),
      Object.create({ resourceName: 'targets' }),
      { resourceName: 'targets', actionName: 'get', [Symbol('x')]: 1 },
    ])
      expect(() => resolveResourceReadRoute(db, resolveIdentity, action)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it('rejects a mismatched target identity', () => {
    expect(() =>
      resolveResourceReadRoute(db, () => ({ ...identity, collectionName: 'sources' }), {
        resourceName: 'targets',
        actionName: 'list',
      }),
    ).toThrow();
    expect(() =>
      resolveResourceReadRoute(db, () => undefined, { resourceName: 'targets', actionName: 'get' }),
    ).toThrow();
  });
  it('rejects changed collection identity or association targets after routing', () => {
    const route = resolveResourceReadRoute(db, resolveIdentity, {
      resourceName: 'sources.parent',
      sourceId: '_',
      actionName: 'get',
    });
    source.setField('parent', { type: 'belongsTo', target: 'sources' });
    expect(() => route.assertCurrent()).toThrow();
    const root = resolveResourceReadRoute(db, resolveIdentity, { resourceName: 'targets', actionName: 'get' });
    db.collection({ name: 'targets' });
    expect(() => root.assertCurrent()).toThrow();
  });
  it('rejects a changed persistent target identity', () => {
    const mutable = { ...identity };
    const route = resolveResourceReadRoute(db, () => mutable, { resourceName: 'targets', actionName: 'list' });
    mutable.collectionKey = 'recreated-target';
    expect(route.identity.collectionKey).toBe('target-key');
    expect(() => route.assertCurrent()).toThrow();
  });
  it('rejects same-named collections belonging to another database', async () => {
    const foreign = sqliteDatabase();
    try {
      const other = foreign.collection({ name: 'targets' });
      db.collections.set('targets', other);
      expect(() =>
        resolveResourceReadRoute(db, resolveIdentity, { resourceName: 'targets', actionName: 'list' }),
      ).toThrow();
      expect(() =>
        resolveResourceReadRoute(db, resolveIdentity, {
          resourceName: 'sources.parent',
          sourceId: '_',
          actionName: 'get',
        }),
      ).toThrow();
    } finally {
      db.collections.set('targets', target);
      await foreign.close();
    }
  });
});

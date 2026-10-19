import { ACL, Resourcer, type Collection, type Database } from '@tego/server';

import type { AccessCollectionIdentity } from '../../access-control/config-store';
import type { AccessEntryReadOperation } from '../../access-control/entry-reads';
import { captureFinalReadPermission } from '../../access-control/final-read-permission';
import {
  prepareRelatedReadContexts,
  type AccessRelatedReadAuthorizer,
} from '../../access-control/related-read-contexts';
import type { AccessRootReadContext } from '../../access-control/root-read-handler';
import { sqliteDatabase } from './database';

describe('related read context preparation', () => {
  let db: Database;
  let docs: Collection;
  let projects: Collection;
  let operation: AccessEntryReadOperation;
  const identity = (collection: Collection): AccessCollectionIdentity => ({
    dataSourceKey: 'main',
    collectionKey: `${collection.name}-key`,
    collectionName: collection.name,
  });
  beforeEach(() => {
    db = sqliteDatabase();
    docs = db.collection({ name: 'documents', fields: [{ name: 'name', type: 'string' }] });
    projects = db.collection({ name: 'projects', fields: [{ name: 'name', type: 'string' }] });
    docs.setField('project', { type: 'belongsTo', target: 'projects' });
    docs.setField('alternate', { type: 'belongsTo', target: 'projects' });
    projects.setField('documents', { type: 'hasMany', target: 'documents' });
    docs.setField('links', { type: 'belongsToMany', target: 'projects', through: 'document_projects' });
    operation = {
      kind: 'list',
      context: {},
      source: identity(docs),
      authenticated: { tenantId: 'B', userId: 28, roleName: 'reader' },
    };
  });
  afterEach(async () => {
    await db.close();
  });

  const finalized = async (collection: Collection, params = {}, raw = {}): Promise<AccessRootReadContext> => {
    const acl = new ACL();
    acl.setAvailableAction('view', { aliases: ['list', 'get'] });
    acl.define({ role: 'reader' }).grantAction(`${collection.name}:view`, params);
    const resourcer = new Resourcer();
    resourcer.define({ name: collection.name, actions: { list: {} } });
    const action = resourcer.getAction(collection.name, 'list').clone();
    Object.assign(action, { resourceName: collection.name, actionName: 'list', sourceId: undefined });
    action.params.filterByTk = undefined;
    action.mergeParams(raw);
    const ctx = {
      db,
      action,
      permission: undefined as unknown,
      state: { currentRole: 'reader', currentUser: { name: 'Visible' } },
      get: () => '+08:00',
      logger: { info: () => {} },
      throw: (status: number) => {
        throw new Error(String(status));
      },
    };
    await acl.middleware()(ctx as never, async () => {});
    return ctx;
  };
  const prepare = (
    paths: unknown,
    authorize: AccessRelatedReadAuthorizer = async (collection: Collection) => finalized(collection),
  ) => prepareRelatedReadContexts(db, identity, operation, paths, authorize);
  const resolveParams = (ctx: AccessRootReadContext | null, collection = projects) => {
    if (!ctx) throw new Error('Missing captured context');
    return captureFinalReadPermission(ctx.permission, {
      resourceName: collection.name,
      actionName: 'list',
      roleName: 'reader',
    });
  };

  it('awaits real core final permissions and binds their resolved templates to this request', async () => {
    const authorize = vi.fn(async (collection: Collection, path: readonly string[], op: AccessEntryReadOperation) => {
      expect(path).toEqual(['project']);
      expect(op).toMatchObject(operation);
      expect(Object.isFrozen(op.authenticated)).toBe(true);
      expect(Object.isFrozen(path)).toBe(true);
      return finalized(collection, { fields: ['name'], filter: { name: '{{ ctx.state.currentUser.name }}' } });
    });
    const sql = vi.spyOn(db.sequelize, 'query');
    const resolve = await prepareRelatedReadContexts(db, identity, operation, [['project']], authorize);
    expect(resolveParams(resolve(projects, ['project'], operation))).toEqual({
      allowed: true,
      params: { fields: ['name'], filter: { name: 'Visible' } },
    });
    expect(authorize).toHaveBeenCalledOnce();
    expect(sql).not.toHaveBeenCalled();
  });

  it('prepares parent paths once and separates paths reaching the same table', async () => {
    const seen: string[] = [];
    const resolve = await prepare([['project', 'documents'], ['project'], ['alternate']], async (collection, path) => {
      seen.push(path.join('.'));
      return finalized(collection, { filter: { name: path.join('.') } });
    });
    expect(seen).toEqual(['project', 'project.documents', 'alternate']);
    expect(resolveParams(resolve(projects, ['alternate'], operation)).params).toEqual({
      filter: { name: 'alternate' },
    });
    expect(resolve(projects, ['missing'], operation)).toBeNull();
  });

  it('prepares the real through model independently of the target', async () => {
    const seen: string[] = [];
    const resolve = await prepare([['links', '$through']], async (collection) => {
      seen.push(collection.name);
      return finalized(collection, { fields: [] });
    });
    const through = db.getCollection('document_projects');
    expect(seen).toEqual(['projects', 'document_projects']);
    expect(resolveParams(resolve(through, ['links', '$through'], operation), through).params).toEqual({ fields: [] });
  });

  it('captures each permission before a later authorization mutates its source', async () => {
    const first = await finalized(projects, { fields: ['name'] });
    const resolve = await prepare([['project'], ['alternate']], async (_collection, path) => {
      if (path[0] === 'project') return first;
      Object.assign((first.permission as { parsedParams: object }).parsedParams, { fields: [] });
      return finalized(projects);
    });
    const captured = resolve(projects, ['project'], operation);
    expect(resolveParams(captured).params).toEqual({ fields: ['name'] });
    Object.assign((captured!.permission as { parsedParams: object }).parsedParams, { fields: [] });
    expect(resolveParams(resolve(projects, ['project'], operation)).params).toEqual({ fields: ['name'] });
  });

  it.each([
    { kind: 'get' },
    { context: {} },
    { authenticated: { tenantId: 'C', userId: 28, roleName: 'reader' } },
    { authenticated: { tenantId: 'B', userId: 29, roleName: 'reader' } },
    { authenticated: { tenantId: 'B', userId: 28, roleName: 'other' } },
    { source: { dataSourceKey: 'external', collectionKey: 'documents-key', collectionName: 'documents' } },
  ])('rejects reuse with another request or identity %j', async (change) => {
    const resolve = await prepare([['project']]);
    expect(() => resolve(projects, ['project'], { ...operation, ...change } as AccessEntryReadOperation)).toThrow();
  });

  it('keeps absent and denied target permissions denied', async () => {
    const resolve = await prepare([['project'], ['alternate']], async (collection, path) => {
      if (path[0] === 'project') return null;
      const result = await finalized(collection);
      Object.assign(result.permission as object, { can: false });
      return result;
    });
    expect(resolve(projects, ['project'], operation)).toBeNull();
    expect(resolveParams(resolve(projects, ['alternate'], operation)).allowed).toBe(false);
  });

  it('rejects constrained contexts and propagates authorization failures', async () => {
    await expect(prepare([['project']], (collection) => finalized(collection, {}, { filter: {} }))).rejects.toThrow();
    const failure = new Error('authorization failed');
    await expect(
      prepare([['project']], async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it.each([
    null,
    {},
    [[]],
    [['missing']],
    [['project', '$through']],
    [['$through']],
    [['project', 'documents', '$through']],
    [Array(10).fill('project')],
    Array(101).fill(['project']),
  ])('rejects malformed or unavailable paths before authorization %j', async (paths) => {
    const authorize = vi.fn(async (collection: Collection) => finalized(collection));
    await expect(prepare(paths, authorize)).rejects.toThrow();
    expect(authorize).not.toHaveBeenCalled();
  });

  it('rejects relation changes during asynchronous preparation and consumption', async () => {
    await expect(
      prepare([['project']], async (collection) => {
        const ctx = await finalized(collection);
        docs.setField('project', { type: 'hasMany', target: 'projects' });
        return ctx;
      }),
    ).rejects.toThrow();
    const resolve = await prepare([['project']]);
    docs.setField('project', { type: 'belongsTo', target: 'projects' });
    expect(() => resolve(projects, ['project'], operation)).toThrow();
  });

  it('rechecks the stable collection identity at consumption', async () => {
    let changed = false;
    const resolve = await prepareRelatedReadContexts(
      db,
      (collection) => ({
        ...identity(collection),
        ...(changed ? { collectionKey: 'replacement' } : {}),
      }),
      operation,
      [['project']],
      (collection) => finalized(collection),
    );
    changed = true;
    expect(() => resolve(projects, ['project'], operation)).toThrow();
  });

  it('rejects replacement of the through descriptor during preparation', async () => {
    const relation = docs.model.associations.links as typeof docs.model.associations.links & {
      through: { model: Collection['model'] };
    };
    await expect(
      prepare([['links', '$through']], async (collection) => {
        const result = await finalized(collection);
        relation.through = { model: docs.model };
        return result;
      }),
    ).rejects.toThrow();
  });

  it('does not invoke getters in path lists', async () => {
    const getter = vi.fn(() => 'project');
    const path: string[] = [];
    Object.defineProperty(path, 0, { get: getter });
    await expect(prepare([path])).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects a valid path consumed for a different collection', async () => {
    const resolve = await prepare([['project']]);
    expect(() => resolve(docs, ['project'], operation)).toThrow();
  });
});

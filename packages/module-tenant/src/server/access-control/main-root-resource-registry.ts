import { Op, type Application, type Collection, type Context } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import type { AccessRootRuntimeSelection } from './authenticated-root-runtime';
import { AccessConfigError } from './config-errors';
import { accessCollectionKey, AccessConfigStore, type AccessCollectionIdentity } from './config-store';
import { resolveModelMetadata } from './model-metadata';
import { AccessRootResourceRuntime } from './root-resource-runtime';

function conflict(): never {
  throw new AccessConfigError('ACCESS_CONFIG_CONFLICT', 'Access configuration metadata changed', 409);
}

/** Main-source discovery for an explicit server selection. Saved configuration alone does not select a table. */
export class AccessMainRootResourceRegistry {
  readonly store: AccessConfigStore;
  private readonly db: Application['db'];
  private readonly source: Application['mainDataSource'];
  private readonly acl: Application['acl'];

  constructor(private readonly app: Application) {
    this.db = app.db;
    this.source = app.mainDataSource;
    this.acl = app.acl;
    this.store = new AccessConfigStore(this.db, (identity) => {
      this.assertCurrent();
      const collection = this.db.getCollection(identity.collectionName);
      if (identity.dataSourceKey !== 'main' || !collection || collection.options.key !== identity.collectionKey)
        conflict();
      return resolveModelMetadata(collection, { resolveCollectionKey: (target) => this.collectionKey(target) });
    });
  }

  private assertCurrent() {
    if (this.app.db !== this.db || this.app.mainDataSource !== this.source || this.app.acl !== this.acl) conflict();
  }

  private collectionKey(collection: Collection) {
    this.assertCurrent();
    if (collection.db !== this.db || this.db.getCollection(collection.name) !== collection) conflict();
    return accessCollectionKey({
      dataSourceKey: 'main',
      collectionName: collection.name,
      collectionKey: collection.options.key,
    });
  }

  async select(
    ctx: Context,
    prepared: AccessAclScopeAdapter,
    selectedKeys: readonly string[],
  ): Promise<AccessRootRuntimeSelection> {
    this.assertCurrent();
    const keys = [...selectedKeys];
    if (
      keys.length > 1000 ||
      keys.some((key) => typeof key !== 'string' || !key || key.length > 255) ||
      new Set(keys).size !== keys.length
    )
      throw new AccessConfigError('INVALID_ACCESS_CONFIG_WRITE', 'Invalid server table selection');
    if (ctx.db !== this.db) conflict();
    const { resourceName, actionName, sourceId } = ctx.action;
    const metadata = this.db.getCollection('collections');
    if (!metadata) conflict();
    const metadataModel = metadata.model;
    const registered = new Map(
      [...this.db.collections.values()].map((collection) => [
        collection.name,
        {
          collection,
          model: collection.model,
          key: collection.options.key,
        },
      ]),
    );
    const query = {
      where: { key: { [Op.in]: keys } },
      attributes: ['key', 'name'],
      limit: keys.length + 1,
      useMaster: true,
      transaction: null,
      hooks: false,
    };
    const rows = keys.length ? await metadataModel.unscoped().findAll(query) : [];
    const assertCurrent = () => {
      this.assertCurrent();
      if (
        ctx.db !== this.db ||
        ctx.action.resourceName !== resourceName ||
        ctx.action.actionName !== actionName ||
        ctx.action.sourceId !== sourceId ||
        this.db.getCollection('collections') !== metadata ||
        metadata.model !== metadataModel
      )
        conflict();
    };
    assertCurrent();
    const identities: AccessCollectionIdentity[] = rows.map((row) => ({
      dataSourceKey: 'main',
      collectionKey: row.get('key'),
      collectionName: row.get('name'),
    }));
    if (
      new Set(identities.map((identity) => identity.collectionName)).size !== identities.length ||
      new Set(identities.map((identity) => identity.collectionKey)).size !== identities.length
    )
      conflict();
    const resolveIdentity = (collection: Collection) => {
      assertCurrent();
      const identity = identities.find((value) => value.collectionName === collection.name);
      if (!identity) {
        if (keys.includes(collection.options.key)) conflict();
        return undefined;
      }
      const captured = registered.get(collection.name);
      if (
        !captured ||
        captured.collection !== collection ||
        this.db.getCollection(collection.name) !== collection ||
        collection.db !== this.db ||
        collection.model !== captured.model ||
        collection.options.key !== captured.key ||
        captured.key !== identity.collectionKey
      )
        conflict();
      return identity;
    };
    return {
      identities,
      runtime: new AccessRootResourceRuntime(
        this.db,
        prepared,
        resolveIdentity,
        (collection) => {
          assertCurrent();
          return this.collectionKey(collection);
        },
        this.acl.middleware(),
      ),
    };
  }
}

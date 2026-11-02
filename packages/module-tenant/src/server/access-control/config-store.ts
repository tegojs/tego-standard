import { isDeepStrictEqual } from 'node:util';
import { Op, type Database, type Model, type Transaction } from '@tego/server';

import { AccessConfigError } from './config-errors';
import { beginConfigWrite, endConfigWrite } from './config-mutation-guard';
import { normalizeAccessContextValue } from './context-values';
import type { AccessConfig, CollectionMetadata } from './types';
import { validateAccessConfig } from './validate';

/** Resolved from registered data sources and persistent metadata, never action parameters. */
export interface AccessCollectionIdentity {
  dataSourceKey: string;
  collectionKey: string;
  collectionName: string;
}

type MetadataResolver = (identity: AccessCollectionIdentity) => CollectionMetadata | Promise<CollectionMetadata>;
export { registerAccessConfigGuards } from './config-mutation-guard';

export interface AccessConfigRevisionPage {
  readonly revisions: readonly { readonly revision: number; readonly actorUserId: string; readonly savedAt: string }[];
  readonly nextBefore: number | null;
}

function positiveRevision(value: number) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new AccessConfigError('INVALID_ACCESS_CONFIG_WRITE', 'Invalid configuration revision');
  return value;
}

function assertIdentity(identity: AccessCollectionIdentity) {
  if (
    !identity ||
    !(['dataSourceKey', 'collectionKey', 'collectionName'] as const).every(
      (key) => typeof identity[key] === 'string' && identity[key].length > 0 && identity[key].length <= 255,
    )
  ) {
    throw new AccessConfigError('INVALID_ACCESS_CONFIG_WRITE', 'Invalid collection identity');
  }
}

/** An unambiguous key; a recreated collection must have a different persistent key. */
export function accessCollectionKey(identity: AccessCollectionIdentity): string {
  assertIdentity(identity);
  return JSON.stringify([identity.dataSourceKey, identity.collectionKey]);
}

function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(immutable);
    Object.freeze(value);
  }
  return value;
}

function storedOptions(record: Model): Record<string, unknown> {
  const options = record.getDataValue('options');
  if (options === null || options === undefined) return {};
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw new AccessConfigError('INVALID_ACCESS_CONFIG_WRITE', 'Invalid collection metadata options');
  }
  return structuredClone(options);
}

/** Primary-database configuration authority. Authentication belongs to the server adapter. */
export class AccessConfigStore {
  constructor(
    private readonly db: Database,
    private readonly metadata: MetadataResolver,
  ) {
    if (!db.inDialect('postgres') && !db.inDialect('sqlite')) {
      throw new AccessConfigError('INVALID_ACCESS_CONFIG_WRITE', 'Unsupported configuration database dialect');
    }
  }

  private async record(identity: AccessCollectionIdentity, transaction?: Transaction) {
    assertIdentity(identity);
    const name = identity.dataSourceKey === 'main' ? 'collections' : 'dataSourcesCollections';
    const collection = this.db.getCollection(name);
    const record = await collection?.model.findOne({
      where: {
        key: identity.collectionKey,
        name: identity.collectionName,
        ...(name === 'dataSourcesCollections' ? { dataSourceKey: identity.dataSourceKey } : {}),
      },
      useMaster: true,
      transaction,
      ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (!record) {
      throw new AccessConfigError('ACCESS_COLLECTION_NOT_FOUND', 'Collection metadata identity is unavailable', 404);
    }
    return { record, collection };
  }

  private async collectionMetadata(identity: AccessCollectionIdentity) {
    const metadata = await this.metadata(identity);
    if (!metadata || metadata.key !== accessCollectionKey(identity)) {
      throw new AccessConfigError('INVALID_ACCESS_CONFIG_WRITE', 'Rule metadata does not match collection identity');
    }
    return metadata;
  }

  private config(options: Record<string, unknown>, metadata: CollectionMetadata): AccessConfig | null {
    if (!Object.hasOwn(options, 'tenantAccess')) return null;
    return immutable(structuredClone(validateAccessConfig(options.tenantAccess, metadata)));
  }

  async read(identity: AccessCollectionIdentity): Promise<AccessConfig | null> {
    identity = this.identity(identity);
    const { record } = await this.record(identity);
    return this.config(storedOptions(record), await this.collectionMetadata(identity));
  }

  /** Primary-only audit summaries. The adapter must authorize the management operation separately. */
  async listRevisions(
    identity: AccessCollectionIdentity,
    limit = 20,
    beforeRevision?: number,
  ): Promise<AccessConfigRevisionPage> {
    identity = this.identity(identity);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new AccessConfigError('INVALID_ACCESS_CONFIG_WRITE', 'Invalid revision page size');
    if (beforeRevision !== undefined) positiveRevision(beforeRevision);
    await this.record(identity);
    const model = this.db.getCollection('tenantAccessRevisions')?.model;
    if (!model) throw new AccessConfigError('ACCESS_COLLECTION_NOT_FOUND', 'Configuration history is unavailable', 404);
    const query = {
      attributes: ['revision', 'actorUserId', 'savedAt'],
      where: { ...identity, ...(beforeRevision === undefined ? {} : { revision: { [Op.lt]: beforeRevision } }) },
      order: [['revision', 'DESC'] as [string, string]],
      limit: limit + 1,
      useMaster: true,
      transaction: null,
      hooks: false,
    };
    const rows = await model.unscoped().findAll(query);
    await this.record(identity);
    const revisions = rows.slice(0, limit).map((row) => {
      const revision = positiveRevision(Number(row.getDataValue('revision')));
      const actorUserId = normalizeAccessContextValue('user.id', row.getDataValue('actorUserId')) as string;
      const savedAt = row.getDataValue('savedAt');
      if (!(savedAt instanceof Date) || !Number.isFinite(savedAt.getTime()))
        throw new AccessConfigError('INVALID_ACCESS_CONFIG_WRITE', 'Invalid configuration history timestamp');
      return { revision, actorUserId, savedAt: savedAt.toISOString() };
    });
    return immutable({ revisions, nextBefore: rows.length > limit ? revisions.at(-1)!.revision : null });
  }

  /** Restore content into a disposable current-base draft; this never saves or enables it. */
  async revisionDraft(
    identity: AccessCollectionIdentity,
    revision: number,
  ): Promise<{ readonly sourceRevision: number; readonly config: AccessConfig }> {
    identity = this.identity(identity);
    positiveRevision(revision);
    const current = await this.read(identity);
    const model = this.db.getCollection('tenantAccessRevisions')?.model;
    const query = {
      attributes: ['config'],
      where: { ...identity, revision },
      useMaster: true,
      transaction: null,
      hooks: false,
    };
    const row = await model?.unscoped().findOne(query);
    if (!current || !row)
      throw new AccessConfigError('ACCESS_COLLECTION_NOT_FOUND', 'Configuration revision is unavailable', 404);
    const historical = validateAccessConfig(
      structuredClone(row.getDataValue('config')),
      await this.collectionMetadata(identity),
    );
    if (historical.revision !== revision || revision > current.revision)
      throw new AccessConfigError('INVALID_ACCESS_CONFIG_WRITE', 'Configuration history revision does not match');
    const config = { ...historical, revision: current.revision };
    const latest = await this.read(identity);
    if (!isDeepStrictEqual(current, latest))
      throw new AccessConfigError(
        'ACCESS_CONFIG_CONFLICT',
        'Access configuration changed; reload before restoring',
        409,
      );
    return immutable({ sourceRevision: revision, config: structuredClone(config) });
  }

  /** The input revision is the editor's base revision, including zero for first migration. */
  async save(
    identity: AccessCollectionIdentity,
    input: unknown,
    actor: { userId: string | number },
  ): Promise<AccessConfig> {
    identity = this.identity(identity);
    const actorUserId = normalizeAccessContextValue('user.id', actor?.userId) as string;
    const submitted = structuredClone(input);
    return this.db.sequelize.transaction(async (transaction) => {
      const { record, collection } = await this.record(identity, transaction);
      const metadata = await this.collectionMetadata(identity);
      const options = storedOptions(record);
      const previousConfig = this.config(options, metadata);
      const validated = validateAccessConfig(submitted, metadata);
      if (validated.revision !== (previousConfig?.revision ?? 0)) {
        throw new AccessConfigError(
          'ACCESS_CONFIG_CONFLICT',
          'Access configuration changed; reload before saving',
          409,
        );
      }
      const config = immutable(
        structuredClone(validateAccessConfig({ ...validated, revision: validated.revision + 1 }, metadata)),
      );
      beginConfigWrite(this.db, transaction, { identity, config, actorUserId });
      try {
        await this.db.getRepository(collection.name).update({
          filter: { key: identity.collectionKey },
          values: { options: { ...options, tenantAccess: structuredClone(config) } },
          transaction,
        });
        const persisted = await this.record(identity, transaction);
        if (!isDeepStrictEqual(this.config(storedOptions(persisted.record), metadata), config)) {
          throw new AccessConfigError(
            'INVALID_ACCESS_CONFIG_WRITE',
            'A metadata hook changed the validated configuration',
          );
        }
        const savedAt = Date.now();
        const audit = await this.db.getRepository('tenantAccessRevisions').create({
          values: {
            ...identity,
            revision: config.revision,
            config,
            previousConfig,
            actorUserId,
            savedAt: new Date(savedAt),
          },
          transaction,
        });
        // Read the stored row: later hooks may have changed the insert or only the returned model.
        const persistedAudit = await this.db.getCollection('tenantAccessRevisions').model.findByPk(audit.get('id'), {
          transaction,
          useMaster: true,
        });
        if (
          !persistedAudit ||
          !(['dataSourceKey', 'collectionKey', 'collectionName'] as const).every(
            (key) => persistedAudit.getDataValue(key) === identity[key],
          ) ||
          String(persistedAudit.getDataValue('revision')) !== String(config.revision) ||
          persistedAudit.getDataValue('actorUserId') !== actorUserId ||
          !isDeepStrictEqual(persistedAudit.getDataValue('config'), config) ||
          !isDeepStrictEqual(persistedAudit.getDataValue('previousConfig'), previousConfig) ||
          persistedAudit.getDataValue('savedAt')?.getTime() !== savedAt
        ) {
          throw new AccessConfigError('INVALID_ACCESS_CONFIG_WRITE', 'A model hook changed the configuration audit');
        }
      } finally {
        endConfigWrite(this.db, transaction);
      }
      return immutable(structuredClone(config));
    });
  }

  private identity(identity: AccessCollectionIdentity): AccessCollectionIdentity {
    assertIdentity(identity);
    return {
      dataSourceKey: identity.dataSourceKey,
      collectionKey: identity.collectionKey,
      collectionName: identity.collectionName,
    };
  }

  /** Construct one per request/execution phase; never cache it on the plugin or across writes. */
  snapshot() {
    const reads = new Map<string, Promise<AccessConfig | null>>();
    return {
      read: (identity: AccessCollectionIdentity): Promise<AccessConfig | null> => {
        const key = JSON.stringify([accessCollectionKey(identity), identity.collectionName]);
        let read = reads.get(key);
        if (!read) {
          read = this.read(identity);
          reads.set(key, read);
        }
        return read;
      },
    };
  }
}

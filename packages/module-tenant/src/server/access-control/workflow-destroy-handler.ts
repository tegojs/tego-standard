import { isDeepStrictEqual } from 'node:util';
import { Op, type Collection, type Database, type Transaction } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { captureAccessFilter } from './filter-input';
import { AccessMutationService } from './mutation';
import type { AccessQueryService } from './query';
import { AccessRoleFilterCompiler } from './role-filter';
import {
  cloneDeep,
  internalQuery,
  invalid,
  normalizeKeys,
  plain,
  requiresSerializable,
  validateWriteTransaction,
} from './write-support';

/** Structural workflow contract, without a runtime dependency on the workflow plugin. */
export interface AccessWorkflowDestroyRequest {
  readonly dataSourceName: string;
  readonly collectionName: string;
  readonly collection: unknown;
  readonly params: unknown;
  readonly context: object;
  readonly transaction?: Transaction;
}

export interface AccessWorkflowDestroyOperation {
  readonly kind: 'destroy';
  readonly context: object;
  readonly source: Readonly<AccessCollectionIdentity>;
  readonly authenticated: Readonly<AccessIdentity>;
}

function data(input: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor) return;
  if (!Object.hasOwn(descriptor, 'value')) invalid('Workflow deletion cannot contain accessors');
  return descriptor.value;
}

function shape(input: unknown, keys: readonly string[]): asserts input is Record<string, unknown> {
  if (!plain(input) || Reflect.ownKeys(input).some((key) => typeof key !== 'string' || !keys.includes(key)))
    invalid('Unsupported workflow deletion parameters');
  for (const key of Reflect.ownKeys(input)) data(input, key);
}

/** Capture before configuration/authentication awaits; preserve original array validation. */
export function captureWorkflowDestroyParams(raw: unknown) {
  shape(raw, ['filter', 'filterByTk', 'individualHooks']);
  const locator = data(raw, 'filterByTk');
  // cloneDeep normalizes array prototypes, so validate the original selection first.
  if (Array.isArray(locator)) {
    if (
      Object.getPrototypeOf(locator) !== Array.prototype ||
      !locator.length ||
      locator.length > 1000 ||
      Reflect.ownKeys(locator).length !== locator.length + 1
    )
      invalid('Workflow deletion requires a bounded dense key selection');
    for (let index = 0; index < locator.length; index++) {
      if (!Object.hasOwn(locator, index)) invalid('Workflow deletion keys cannot contain holes');
      data(locator, String(index));
    }
  }
  const requestFilter = captureAccessFilter(raw.filter === undefined ? {} : raw.filter);
  const params = cloneDeep(raw);
  const individualHooks = params.individualHooks;
  if (individualHooks !== undefined && typeof individualHooks !== 'boolean')
    invalid('Workflow individualHooks must be a boolean');
  const hookOptions = typeof individualHooks === 'boolean' ? { individualHooks } : {};
  return { params, requestFilter, hookOptions };
}

/** Internal only. The caller supplies trusted execution identity, final grants and an adequate root transaction. */
export class AccessWorkflowDestroyHandler {
  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly queries: AccessQueryService,
    private readonly resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
    private readonly resolvePermission: (collection: Collection, operation: AccessWorkflowDestroyOperation) => unknown,
  ) {}

  /** Any error requires the caller to roll back its entire transaction, including earlier workflow writes. */
  async handle(request: AccessWorkflowDestroyRequest, authenticated: AccessIdentity): Promise<number> {
    if (!plain(request) || !plain(authenticated)) invalid('Workflow deletion execution context is unavailable');
    const actor = Object.freeze(cloneDeep(authenticated));
    const dataSourceName = data(request, 'dataSourceName');
    const collectionName = data(request, 'collectionName');
    const target = data(request, 'collection');
    const context = data(request, 'context');
    const transaction = data(request, 'transaction') as Transaction | undefined;
    const { params, requestFilter, hookOptions } = captureWorkflowDestroyParams(data(request, 'params'));
    if (
      typeof dataSourceName !== 'string' ||
      typeof collectionName !== 'string' ||
      !context ||
      typeof context !== 'object' ||
      Array.isArray(context)
    )
      invalid('Workflow deletion target or context is unavailable');
    const collection = this.db.getCollection(collectionName);
    if (
      !collection ||
      collection !== target ||
      collection.db !== this.db ||
      this.db.modelCollection.get(collection.model) !== collection ||
      collection.model.sequelize !== this.db.sequelize
    )
      invalid('Workflow deletion collection does not match its database target');
    const model = collection.model;
    const identity = Object.freeze(cloneDeep(this.resolveIdentity(collection)));
    if (!identity || identity.collectionName !== collectionName || identity.dataSourceKey !== dataSourceName)
      invalid('Workflow deletion identity does not match its data source');
    const key = accessCollectionKey(identity);
    if (collection.filterTargetKey !== model.primaryKeyAttribute || model.primaryKeyAttributes.length !== 1)
      invalid('Workflow deletion requires a single primary target key');
    const config = this.prepared.configuration(context, identity);
    if (!config) invalid('Workflow deletion requires a prepared access configuration');
    const explicit = params.filterByTk !== undefined;
    let keys = explicit
      ? normalizeKeys(Array.isArray(params.filterByTk) ? params.filterByTk : [params.filterByTk], collection)
      : [];
    const operation: AccessWorkflowDestroyOperation = Object.freeze({
      kind: 'destroy',
      context,
      source: identity,
      authenticated: actor,
    });
    const capturePermission = () => {
      const input = this.resolvePermission(collection, operation);
      shape(input, ['source', 'actionName', 'allowed', 'params']);
      const rawGrants = data(input, 'params');
      shape(rawGrants, ['filter', 'fields', 'whitelist', 'blacklist', 'own']);
      const filter = captureAccessFilter(rawGrants.filter === undefined ? {} : rawGrants.filter);
      const grant = cloneDeep(input);
      if (
        !plain(grant.source) ||
        grant.source.collectionName !== collectionName ||
        accessCollectionKey(grant.source as unknown as AccessCollectionIdentity) !== key ||
        grant.actionName !== 'destroy' ||
        grant.allowed !== true
      )
        invalid('Workflow deletion is not authorized for this target');
      if (Object.hasOwn(rawGrants, 'own') && rawGrants.own !== false)
        invalid('Workflow destroy permissions must be finalized');
      for (const name of ['fields', 'whitelist', 'blacklist']) {
        const value = rawGrants[name];
        if (value === undefined) continue;
        const fields = captureAccessFilter(value);
        if (
          !Array.isArray(fields) ||
          new Set(fields).size !== fields.length ||
          fields.some(
            (field) =>
              typeof field !== 'string' ||
              (!Object.hasOwn(model.rawAttributes, field) && !Object.hasOwn(model.associations, field)),
          )
        )
          invalid('Workflow destroy permission fields are unavailable');
      }
      return {
        ...grant,
        params: {
          ...cloneDeep(rawGrants),
          filter,
        },
      };
    };
    const permission = capturePermission();
    const compiler = new AccessRoleFilterCompiler(this.db, this.resolveIdentity);
    const role = compiler.compile(identity, permission.params.filter);
    const condition = compiler.compile(identity, requestFilter);
    // User-selected relationship filters need independent read grants; final role facts do not grant those reads.
    if (condition.rootWhere === undefined) invalid('Workflow relationship deletion filters require their own adapter');
    const where = { [Op.and]: [role.rootWhere ?? role.where, condition.rootWhere] };
    const serializable = requiresSerializable(config, { where }, collection);
    const assertCurrent = () => {
      const current = this.resolveIdentity(collection);
      if (
        !current ||
        current.collectionName !== collectionName ||
        accessCollectionKey(current) !== key ||
        collection.filterTargetKey !== model.primaryKeyAttribute ||
        this.prepared.configuration(context, identity) !== config ||
        !this.queries.isCurrentCollection(identity, collection, model)
      )
        invalid('Workflow deletion identity or preparation phase changed');
      role.assertCurrent();
      condition.assertCurrent();
      if (!isDeepStrictEqual(permission, capturePermission())) invalid('Workflow destroy permission changed');
    };
    await validateWriteTransaction(this.db, transaction, serializable);
    assertCurrent();
    if (!explicit) {
      const scoped = await this.queries.scopeQuery(context, identity, actor, { where, transaction }, 'ownership');
      assertCurrent();
      if (!scoped || scoped.config !== config) invalid('Workflow deletion preparation phase changed');
      const records = await model.findAll(
        internalQuery({
          ...scoped.query,
          attributes: [model.primaryKeyAttribute],
          order: [[model.primaryKeyAttribute, 'ASC']],
          limit: 1001,
          lock: transaction!.LOCK.UPDATE,
        }),
      );
      assertCurrent();
      if (records.length > 1000) invalid('Workflow deletion exceeds the 1000-record write limit');
      if (!records.length) {
        await validateWriteTransaction(this.db, transaction, serializable);
        assertCurrent();
        return 0;
      }
      keys = normalizeKeys(
        records.map((record) => record.getDataValue(model.primaryKeyAttribute)),
        collection,
      );
    }
    const result = await new AccessMutationService(
      this.db,
      this.prepared,
      this.queries,
    ).withExistingRecordsInTransaction(
      context,
      identity,
      actor,
      { operation: 'destroy', keys, where },
      transaction!,
      async (plan) => {
        for (const record of plan.records) {
          assertCurrent();
          await collection.repository.destroy({
            filterByTk: record.getDataValue(model.primaryKeyAttribute),
            transaction: plan.transaction,
            context,
            ...hookOptions,
          });
          assertCurrent();
        }
      },
      assertCurrent,
    );
    assertCurrent();
    return result.affected;
  }
}

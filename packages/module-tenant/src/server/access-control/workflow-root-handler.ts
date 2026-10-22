import type { Collection, Database, Transaction } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import { AccessEntryReadService } from './entry-reads';
import type { AccessQueryService } from './query';
import { captureReadDateContext, type AccessReadDateContext } from './read-date-filter';
import { collectRelatedReadPaths } from './read-paths';
import { parseWorkflowQueryParams } from './resource-read-params';
import {
  AccessWorkflowDestroyHandler,
  captureWorkflowDestroyParams,
  type AccessWorkflowDestroyRequest,
} from './workflow-destroy-handler';
import { captureWorkflowAccessIdentity } from './workflow-identity';
import { AccessWorkflowQueryHandler, type AccessWorkflowQueryRequest } from './workflow-query-handler';
import { cloneDeep, invalid, plain } from './write-support';

/** Structural contract; the installed workflow plugin supplies its live, instance-bound verifier. */
export interface AccessWorkflowOperationAuthority {
  readonly actionName: 'list' | 'destroy';
  readonly dataSourceName: string;
  readonly collectionName: string;
  readonly collection: unknown;
  readonly context: object;
  readonly transaction?: Transaction;
  assertCurrent(): void;
}

function data(input: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, name);
  if (!descriptor) return;
  if (!Object.hasOwn(descriptor, 'value')) invalid('Workflow operation cannot contain accessors');
  return descriptor.value;
}

/** Internal root-only composition. It is selected explicitly, never registered or enabled by this class. */
export class AccessWorkflowRootHandler {
  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly queries: AccessQueryService,
    private readonly resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
    private readonly captureAuthority: (request: unknown) => AccessWorkflowOperationAuthority,
  ) {
    if (typeof captureAuthority !== 'function') invalid('Workflow operations require an installed authority verifier');
  }

  private operation(request: unknown, action: AccessWorkflowOperationAuthority['actionName']) {
    if (!plain(request)) invalid('Workflow operation request is unavailable');
    const authority = this.captureAuthority(request);
    if (!plain(authority) || data(authority, 'actionName') !== action)
      invalid('Workflow operation authority does not match the requested action');
    const check = data(authority, 'assertCurrent');
    if (typeof check !== 'function') invalid('Workflow operation authority cannot be verified');
    const assertCurrent = () => {
      check.call(authority);
    };
    assertCurrent();
    for (const name of ['dataSourceName', 'collectionName', 'collection', 'context', 'transaction']) {
      if (data(authority, name) !== data(request, name))
        invalid('Workflow operation authority does not match its request');
    }
    const dataSourceName = data(authority, 'dataSourceName');
    const collectionName = data(authority, 'collectionName');
    const collection = data(authority, 'collection');
    const context = data(authority, 'context');
    const transaction = data(authority, 'transaction') as Transaction | undefined;
    if (
      typeof dataSourceName !== 'string' ||
      typeof collectionName !== 'string' ||
      !context ||
      typeof context !== 'object' ||
      Array.isArray(context)
    )
      invalid('Workflow operation target or context is unavailable');
    const authenticated = captureWorkflowAccessIdentity(context);
    return { dataSourceName, collectionName, collection, context, transaction, authenticated, assertCurrent };
  }

  private target(operation: ReturnType<AccessWorkflowRootHandler['operation']>) {
    const collection = this.db.getCollection(operation.collectionName);
    if (
      !collection ||
      collection !== operation.collection ||
      collection.db !== this.db ||
      collection.model.sequelize !== this.db.sequelize
    )
      invalid('Workflow root target does not match its database');
    const model = collection.model;
    const identity = this.resolveIdentity(collection);
    if (
      !plain(identity) ||
      identity.collectionName !== operation.collectionName ||
      identity.dataSourceKey !== operation.dataSourceName
    )
      invalid('Workflow root target identity does not match its data source');
    const source = Object.freeze(cloneDeep(identity));
    const key = accessCollectionKey(source);
    const assertCurrent = () => {
      operation.assertCurrent();
      const current = this.resolveIdentity(collection);
      if (
        !current ||
        current.collectionName !== source.collectionName ||
        accessCollectionKey(current) !== key ||
        this.db.getCollection(source.collectionName) !== collection ||
        collection.model !== model ||
        this.db.modelCollection.get(model) !== collection
      )
        invalid('Workflow root target changed during execution');
    };
    assertCurrent();
    return { collection, source, key, assertCurrent };
  }

  async query(request: AccessWorkflowQueryRequest, dates?: AccessReadDateContext) {
    const operation = this.operation(request, 'list');
    const multiple = data(request, 'multiple');
    const parsed = parseWorkflowQueryParams(data(request, 'query'), multiple);
    const dateContext = dates === undefined ? undefined : captureReadDateContext(dates);
    const query = { ...parsed.request, limit: parsed.complete ? undefined : parsed.request.limit };
    const target = this.target(operation);
    const captured: AccessWorkflowQueryRequest = {
      dataSourceName: operation.dataSourceName,
      collectionName: operation.collectionName,
      collection: target.collection,
      context: operation.context,
      transaction: operation.transaction,
      multiple: multiple as boolean,
      query,
    };
    return this.prepared.withPrepared(operation.context, [target.source], async () => {
      target.assertCurrent();
      if (!this.prepared.configuration(operation.context, target.source))
        invalid('Workflow root reads require an explicit access configuration');
      const { limit: _limit, offset: _offset, ...selection } = parsed.request;
      const paths = collectRelatedReadPaths(
        this.db,
        this.prepared,
        this.queries,
        this.resolveIdentity,
        {
          kind: 'list',
          context: operation.context,
          source: target.source,
          authenticated: operation.authenticated,
        },
        selection,
        dateContext,
      );
      if (paths.length) invalid('Workflow associations require an independent authorization adapter');
      const reader = new AccessEntryReadService(
        this.db,
        this.prepared,
        this.queries,
        this.resolveIdentity,
        (collection, path, read) => {
          target.assertCurrent();
          return {
            allowed:
              collection === target.collection &&
              path.length === 0 &&
              read.kind === 'list' &&
              read.context === operation.context &&
              read.source.collectionName === target.source.collectionName &&
              accessCollectionKey(read.source) === target.key,
            params: {},
          };
        },
      );
      const result = await new AccessWorkflowQueryHandler(this.db, reader, this.resolveIdentity).handle(
        captured,
        operation.authenticated,
        dateContext,
      );
      target.assertCurrent();
      return result;
    });
  }

  async destroy(request: AccessWorkflowDestroyRequest): Promise<number> {
    const operation = this.operation(request, 'destroy');
    const params = captureWorkflowDestroyParams(data(request, 'params')).params;
    const target = this.target(operation);
    const captured: AccessWorkflowDestroyRequest = {
      dataSourceName: operation.dataSourceName,
      collectionName: operation.collectionName,
      collection: target.collection,
      context: operation.context,
      transaction: operation.transaction,
      params,
    };
    return this.prepared.withPrepared(operation.context, [target.source], async () => {
      target.assertCurrent();
      if (!this.prepared.configuration(operation.context, target.source))
        invalid('Workflow root deletion requires an explicit access configuration');
      const result = await new AccessWorkflowDestroyHandler(
        this.db,
        this.prepared,
        this.queries,
        this.resolveIdentity,
        (collection, write) => {
          target.assertCurrent();
          return {
            source: target.source,
            actionName: 'destroy',
            allowed:
              collection === target.collection &&
              write.context === operation.context &&
              write.source.collectionName === target.source.collectionName &&
              accessCollectionKey(write.source) === target.key,
            params: {},
          };
        },
      ).handle(captured, operation.authenticated);
      target.assertCurrent();
      return result;
    });
  }
}

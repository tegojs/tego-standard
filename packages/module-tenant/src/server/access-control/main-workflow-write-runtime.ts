import { isDeepStrictEqual } from 'node:util';
import type { Application, Collection } from '@tego/server';

import { AccessAclScopeAdapter } from './acl-scope';
import { AccessConfigError } from './config-errors';
import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import { assertLegacyReadBoundary } from './legacy-read-boundary';
import { assertLegacyDestroyBoundary, assertLegacyWriteBoundary } from './legacy-write-boundary';
import { AccessMainRootResourceRegistry } from './main-root-resource-registry';
import { AccessQueryService } from './query';
import type { AccessWorkflowDestroyRequest } from './workflow-destroy-handler';
import { AccessWorkflowRootHandler, type AccessWorkflowOperationAuthority } from './workflow-root-handler';
import type { AccessWorkflowScalarWriteRequest } from './workflow-scalar-write';
import {
  AccessWorkflowWriteTransactionPlanner,
  type AccessWorkflowWriteTransactionTarget,
} from './workflow-write-transaction';
import { cloneDeep, invalid } from './write-support';

type WriteAction = 'create' | 'update' | 'destroy';

/** Explicit server composition; never installed by the tenant plugin. */
export class AccessMainWorkflowWriteRuntime {
  readonly registry: AccessMainRootResourceRegistry;

  constructor(
    private readonly app: Application,
    private readonly captureAuthority: (request: unknown) => AccessWorkflowOperationAuthority,
  ) {
    this.registry = new AccessMainRootResourceRegistry(app);
  }

  async plan(target: AccessWorkflowWriteTransactionTarget, selected: readonly AccessCollectionIdentity[]) {
    const selections = this.select(target, selected);
    if (!selections) return undefined;
    // Planning has no live operation authority and never grants permission to write.
    const discovered = await this.discover(target, selections, () => {});
    const options = await new AccessWorkflowWriteTransactionPlanner(
      this.app.db,
      this.registry.store,
      discovered.resolveIdentity,
    ).plan(target);
    discovered.assertCurrent();
    return options;
  }

  resolveCreate(request: AccessWorkflowScalarWriteRequest, selected: readonly AccessCollectionIdentity[]) {
    return this.resolve('create', request, selected);
  }

  resolveUpdate(request: AccessWorkflowScalarWriteRequest, selected: readonly AccessCollectionIdentity[]) {
    return this.resolve('update', request, selected);
  }

  resolveDestroy(request: AccessWorkflowDestroyRequest, selected: readonly AccessCollectionIdentity[]) {
    return this.resolve('destroy', request, selected);
  }

  /** Upsert has no dedicated operation authority or atomic selected executor yet. */
  assertUpdateOrCreateBoundary(
    request: AccessWorkflowScalarWriteRequest,
    selected: readonly AccessCollectionIdentity[],
  ) {
    if (this.select(request, selected)) invalid('Selected workflow upserts require a dedicated adapter');
    if (request.dataSourceName !== 'main' || !selected.length) return;
    const collection = this.app.db.getCollection(request.collectionName);
    if (!collection || collection !== request.collection) invalid('Legacy workflow upsert target changed');
    const protectedCollection = (target: Collection) =>
      selected.some((identity) => identity.collectionName === target.name);
    assertLegacyReadBoundary(this.app.db, collection, request.params as object, protectedCollection, request.context);
    assertLegacyWriteBoundary(this.app.db, collection, request.params as object, protectedCollection);
  }

  private select(target: AccessWorkflowWriteTransactionTarget, selected: readonly AccessCollectionIdentity[]) {
    const selections = selected.map((identity) => ({ ...identity }));
    if (
      selections.length > 1000 ||
      selections.some((identity) => identity.dataSourceKey !== 'main') ||
      new Set(selections.map(accessCollectionKey)).size !== selections.length ||
      new Set(selections.map((identity) => identity.collectionName)).size !== selections.length
    )
      invalid('Invalid main workflow table selection');
    return target.dataSourceName === 'main' &&
      selections.some((identity) => identity.collectionName === target.collectionName)
      ? selections
      : undefined;
  }

  private async discover(
    target: AccessWorkflowWriteTransactionTarget,
    selections: readonly AccessCollectionIdentity[],
    assertOperationCurrent: () => void,
  ) {
    const db = this.app.db;
    const collection = db.getCollection(target.collectionName);
    if (!collection || collection !== target.collection) invalid('Workflow write target changed');
    const model = collection.model;
    const discovered = await this.registry.discover(
      selections.map((identity) => identity.collectionKey),
      () => {
        assertOperationCurrent();
        if (this.app.db !== db || db.getCollection(collection.name) !== collection || collection.model !== model)
          invalid('Workflow write target changed');
      },
    );
    for (const selection of selections) {
      const actual = discovered.identities.find((identity) => identity.collectionName === selection.collectionName);
      if (!actual || accessCollectionKey(actual) !== accessCollectionKey(selection))
        throw new AccessConfigError('ACCESS_CONFIG_CONFLICT', 'Access configuration metadata changed', 409);
    }
    return discovered;
  }

  private resolve<Action extends WriteAction>(
    action: Action,
    request: AccessWorkflowScalarWriteRequest,
    selected: readonly AccessCollectionIdentity[],
  ) {
    const selections = this.select(request, selected);
    if (!selections) {
      if (request.dataSourceName === 'main' && selected.length) {
        const collection = this.app.db.getCollection(request.collectionName);
        if (!collection || collection !== request.collection) invalid('Legacy workflow write target changed');
        const protectedCollection = (target: Collection) =>
          selected.some((identity) => identity.collectionName === target.name);
        assertLegacyReadBoundary(
          this.app.db,
          collection,
          request.params as object,
          protectedCollection,
          request.context,
        );
        if (action === 'destroy') assertLegacyDestroyBoundary(this.app.db, collection, protectedCollection);
        else assertLegacyWriteBoundary(this.app.db, collection, request.params as object, protectedCollection);
      }
      return undefined;
    }
    const params = request.params;
    const captured = cloneDeep(params);
    return async (
      incoming: AccessWorkflowScalarWriteRequest,
    ): Promise<Awaited<ReturnType<AccessWorkflowRootHandler[Action]>>> => {
      if (incoming !== request) invalid('Workflow write executor request changed');
      const authority = this.captureAuthority(request);
      authority.assertCurrent();
      if (authority.actionName !== action) invalid('Workflow write authority does not match the requested action');
      const assertCurrent = () => {
        authority.assertCurrent();
        if (request.params !== params || !isDeepStrictEqual(cloneDeep(params), captured))
          invalid('Workflow write parameters changed during discovery');
      };
      const discovered = await this.discover(request, selections, assertCurrent);
      const prepared = new AccessAclScopeAdapter(this.app.acl, 'main', this.registry.store, this.app.db);
      const queries = new AccessQueryService(this.app.db, prepared, discovered.resolveCollectionKey);
      const handler = new AccessWorkflowRootHandler(
        this.app.db,
        prepared,
        queries,
        discovered.resolveIdentity,
        this.captureAuthority,
      );
      const result = await handler[action](request);
      discovered.assertCurrent();
      return result as Awaited<ReturnType<AccessWorkflowRootHandler[Action]>>;
    };
  }
}

import type { Collection, Database, Transaction } from '@tego/server';

import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import type { AccessEntryReadService } from './entry-reads';
import { captureReadDateContext, type AccessReadDateContext } from './read-date-filter';
import { parseWorkflowQueryParams } from './resource-read-params';
import { cloneDeep, invalid, plain } from './write-support';

/** Structural workflow executor contract; no runtime dependency on the workflow plugin. */
export interface AccessWorkflowQueryRequest {
  readonly dataSourceName: string;
  readonly collectionName: string;
  readonly collection: unknown;
  readonly multiple: boolean;
  readonly query: unknown;
  readonly context: object;
  readonly transaction?: Transaction;
}

function data(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor) return;
  if (!Object.hasOwn(descriptor, 'value')) invalid('Workflow query request cannot contain accessors');
  return descriptor.value;
}

/** Internal adapter only; the caller supplies a prepared phase, execution identity and finalized grants. */
export class AccessWorkflowQueryHandler {
  constructor(
    private readonly db: Database,
    private readonly reader: AccessEntryReadService,
    private readonly resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  ) {}

  async handle(request: AccessWorkflowQueryRequest, authenticated: AccessIdentity, dates?: AccessReadDateContext) {
    if (!plain(request) || !plain(authenticated))
      invalid('Workflow query request or execution identity is unavailable');
    const actor = cloneDeep(authenticated);
    const dataSourceName = data(request, 'dataSourceName');
    const collectionName = data(request, 'collectionName');
    const target = data(request, 'collection');
    const context = data(request, 'context');
    const multiple = data(request, 'multiple');
    const transaction = data(request, 'transaction') as Transaction | undefined;
    const parsed = parseWorkflowQueryParams(data(request, 'query'), multiple);
    const params = { ...parsed.request, limit: parsed.complete ? undefined : parsed.request.limit };
    const dateContext = dates === undefined ? undefined : captureReadDateContext(dates);
    if (
      typeof collectionName !== 'string' ||
      typeof dataSourceName !== 'string' ||
      !context ||
      typeof context !== 'object' ||
      Array.isArray(context)
    )
      invalid('Workflow query target or context is unavailable');
    const collection = this.db.collections.get(collectionName);
    if (!collection || collection.db !== this.db || collection !== target)
      invalid('Workflow query collection does not match the execution target');
    const model = collection.model;
    const resolved = this.resolveIdentity(collection);
    if (!resolved || resolved.collectionName !== collectionName || resolved.dataSourceKey !== dataSourceName)
      invalid('Workflow query identity does not match the execution data source');
    const identity = cloneDeep(resolved);
    const assertCurrent = () => {
      const current = this.resolveIdentity(collection);
      if (
        this.db.collections.get(collectionName) !== collection ||
        collection.model !== model ||
        !current ||
        current.collectionName !== collectionName ||
        accessCollectionKey(current) !== accessCollectionKey(identity)
      )
        invalid('Workflow query target identity changed during execution');
    };
    assertCurrent();
    const result = await this.reader.workflowReadFromParams(
      context,
      identity,
      actor,
      params,
      multiple,
      transaction,
      dateContext,
    );
    assertCurrent();
    result.assertCurrent();
    return result.value;
  }
}

import { Transaction, type ICollection } from '@tego/server';

import type { TransactionOptions } from 'sequelize';

import type { IJob } from '.';
import { JOB_STATUS } from '../constants';
import { bindWorkflowDataOperationRequest } from '../data-operation-authority';
import { withWorkflowDataSourceTransaction } from '../helpers/tenant-context';
import type Plugin from '../Plugin';
import type Processor from '../Processor';
import type { FlowNodeModel } from '../types';
import { toJSON } from '../utils';
import { captureWorkflowWritePlanningInputs, captureWorkflowWriteValueFields } from './write-planning-snapshot';

export interface WorkflowWriteRequest {
  readonly dataSourceName: string;
  readonly collectionName: string;
  readonly collection: ICollection;
  readonly params: Record<string, unknown>;
  readonly context: ReturnType<Processor['getRepositoryContext']>;
  readonly transaction?: Transaction;
}

export type WorkflowCreateRequest = WorkflowWriteRequest;
export type WorkflowUpdateRequest = WorkflowWriteRequest;
export type WorkflowCreateResult = Record<string, unknown>;
export interface WorkflowUpdateResult {
  length: number;
  data: Record<string, unknown>[];
}
export type WorkflowCreateExecutor = (request: WorkflowCreateRequest) => Promise<WorkflowCreateResult>;
export type WorkflowUpdateExecutor = (request: WorkflowUpdateRequest) => Promise<WorkflowUpdateResult>;
/** Server-only synchronous selection; executors own the full write, response projection and authorization. */
export type WorkflowCreateResolver = (request: WorkflowCreateRequest) => WorkflowCreateExecutor | undefined;
export type WorkflowUpdateResolver = (request: WorkflowUpdateRequest) => WorkflowUpdateExecutor | undefined;

export type WorkflowWriteTransactionTarget = Pick<
  WorkflowWriteRequest,
  'dataSourceName' | 'collectionName' | 'collection'
> & { readonly valueFields?: readonly string[] };
export type WorkflowWriteTransactionOptions = Pick<TransactionOptions, 'type' | 'isolationLevel'>;
/** Target and field-name policy loading before a new transaction; never grants write authority. */
export type WorkflowWriteTransactionPlanner = (
  target: WorkflowWriteTransactionTarget,
) => WorkflowWriteTransactionOptions | undefined | Promise<WorkflowWriteTransactionOptions | undefined>;

function captureTransactionOptions(input: unknown): WorkflowWriteTransactionOptions | undefined {
  if (input === undefined) return;
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
    throw new TypeError('Invalid write transaction options');
  const result: WorkflowWriteTransactionOptions = {};
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
    if (!['type', 'isolationLevel'].includes(key as string) || !Object.hasOwn(descriptor, 'value'))
      throw new TypeError('Invalid write transaction options');
    const value: unknown = descriptor.value;
    const allowed = key === 'type' ? Object.values(Transaction.TYPES) : Object.values(Transaction.ISOLATION_LEVELS);
    if (value !== undefined && !allowed.some((option) => option === value))
      throw new TypeError('Invalid write transaction options');
    if (key === 'type') result.type = value as TransactionOptions['type'];
    else result.isolationLevel = value as TransactionOptions['isolationLevel'];
  }
  return result;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Internal instruction bridge. Without server hooks, the original attachment/transaction order is unchanged. */
export async function runWorkflowWriteResolver(
  action: 'create' | 'update',
  workflow: Plugin,
  processor: Processor,
  node: FlowNodeModel,
  target: Omit<WorkflowWriteRequest, 'transaction'>,
  resolve: WorkflowCreateResolver | WorkflowUpdateResolver | undefined,
  runDefault: (transaction?: Transaction) => Promise<IJob>,
  transactionPlanner?: WorkflowWriteTransactionPlanner,
): Promise<IJob> {
  if (!resolve && !transactionPlanner) return runDefault();
  const processorTransaction = processor.transaction;
  let transactionOptions: WorkflowWriteTransactionOptions | undefined;
  let assertPlanningInputsCurrent: (() => void) | undefined;
  if (transactionPlanner && !workflow.useDataSourceTransaction(target.dataSourceName, processorTransaction)) {
    const source = workflow.app.dataSourceManager.dataSources.get(target.dataSourceName);
    const manager = source.collectionManager;
    const database = (manager as { db?: { sequelize?: unknown } }).db;
    const connection = database?.sequelize;
    assertPlanningInputsCurrent = captureWorkflowWritePlanningInputs(target.params, target.context);
    const valueFields = captureWorkflowWriteValueFields(target.params);
    const planned = await transactionPlanner(
      Object.freeze({
        dataSourceName: target.dataSourceName,
        collectionName: target.collectionName,
        collection: target.collection,
        valueFields,
      }),
    );
    if (
      workflow.app.dataSourceManager.dataSources.get(target.dataSourceName) !== source ||
      source.collectionManager !== manager ||
      (manager as { db?: unknown }).db !== database ||
      database?.sequelize !== connection ||
      manager.getCollection(target.collectionName) !== target.collection
    )
      throw new TypeError('Write transaction target changed during planning');
    assertPlanningInputsCurrent();
    transactionOptions = captureTransactionOptions(planned);
  }
  return withWorkflowDataSourceTransaction(
    workflow,
    target.dataSourceName,
    processorTransaction,
    async (transaction) => {
      assertPlanningInputsCurrent?.();
      if (!resolve) return runDefault(transaction);
      const request: WorkflowWriteRequest = Object.freeze({ ...target, transaction });
      bindWorkflowDataOperationRequest(request, action, processor, node);
      const execute = resolve(request);
      if (execute === undefined) return runDefault(transaction);
      if (typeof execute !== 'function') {
        await execute;
        throw new TypeError(`${action} resolver must select an executor or undefined`);
      }
      const result = toJSON(await execute(request));
      if (
        !record(result) ||
        (action === 'update' &&
          (typeof result.length !== 'number' ||
            !Number.isSafeInteger(result.length) ||
            result.length < 0 ||
            !Array.isArray(result.data) ||
            result.data.length > result.length ||
            !result.data.every(record)))
      )
        throw new TypeError(`Invalid ${action} executor result`);
      return { result, status: JOB_STATUS.RESOLVED };
    },
    transactionOptions,
  );
}

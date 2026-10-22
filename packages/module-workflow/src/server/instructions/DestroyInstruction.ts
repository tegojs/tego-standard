import { parseCollectionName, Transaction, type ICollection } from '@tego/server';

import type { TransactionOptions } from 'sequelize';

import { Instruction } from '.';
import { JOB_STATUS } from '../constants';
import { bindWorkflowDataOperationRequest } from '../data-operation-authority';
import {
  resolveTenantDestroyOptions,
  withWorkflowDataSourceTransaction,
  workflowTenantRecordMutationMissError,
} from '../helpers/tenant-context';
import type Plugin from '../Plugin';
import type Processor from '../Processor';
import type { FlowNodeModel } from '../types';

export interface WorkflowDestroyRequest {
  readonly dataSourceName: string;
  readonly collectionName: string;
  readonly collection: ICollection;
  readonly params: Record<string, unknown>;
  readonly context: ReturnType<Processor['getRepositoryContext']>;
  readonly transaction?: Transaction;
}

export type WorkflowDestroyExecutor = (request: WorkflowDestroyRequest) => Promise<number>;
/** Server-only synchronous selection; the executor owns authorization, deletion and post-write checks. */
export type WorkflowDestroyResolver = (request: WorkflowDestroyRequest) => WorkflowDestroyExecutor | undefined;

export type WorkflowDestroyTransactionRequest = Omit<WorkflowDestroyRequest, 'transaction'>;
export type WorkflowDestroyTransactionOptions = Pick<TransactionOptions, 'type' | 'isolationLevel'>;
/** Server-only synchronous planning, before creating a node-owned transaction; does not authorize deletion. */
export type WorkflowDestroyTransactionOptionsResolver = (
  request: WorkflowDestroyTransactionRequest,
) => WorkflowDestroyTransactionOptions | undefined;

export type WorkflowDestroyTransactionTarget = Pick<
  WorkflowDestroyRequest,
  'dataSourceName' | 'collectionName' | 'collection'
>;
/** Target-only asynchronous policy loading; neither a delete request nor operation authorization. */
export type WorkflowDestroyTransactionPlanner = (
  target: WorkflowDestroyTransactionTarget,
) => WorkflowDestroyTransactionOptions | undefined | Promise<WorkflowDestroyTransactionOptions | undefined>;

function captureTransactionOptions(input: object): WorkflowDestroyTransactionOptions {
  const result: WorkflowDestroyTransactionOptions = {};
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
    if (!['type', 'isolationLevel'].includes(key as string) || !Object.hasOwn(descriptor, 'value'))
      throw new TypeError('Invalid destroy transaction options');
    const value: unknown = descriptor.value;
    const allowed = key === 'type' ? Object.values(Transaction.TYPES) : Object.values(Transaction.ISOLATION_LEVELS);
    if (value !== undefined && !allowed.some((option) => option === value))
      throw new TypeError('Invalid destroy transaction options');
    if (key === 'type') result.type = value as TransactionOptions['type'];
    else result.isolationLevel = value as TransactionOptions['isolationLevel'];
  }
  return result;
}

/**
 * Runs the destroy instruction workflow instruction.
 */
export class DestroyInstruction extends Instruction {
  constructor(
    workflow: Plugin,
    private readonly resolve?: WorkflowDestroyResolver,
    private readonly transactionOptions?: WorkflowDestroyTransactionOptionsResolver,
    private readonly transactionPlanner?: WorkflowDestroyTransactionPlanner,
  ) {
    super(workflow);
    if (resolve !== undefined && typeof resolve !== 'function') {
      throw new TypeError('Destroy resolver must be a function');
    }
    if (transactionOptions !== undefined && typeof transactionOptions !== 'function') {
      throw new TypeError('Destroy transaction options must be a function');
    }
    if (transactionPlanner !== undefined && typeof transactionPlanner !== 'function') {
      throw new TypeError('Destroy transaction planner must be a function');
    }
    if (transactionOptions && transactionPlanner) {
      throw new TypeError('Destroy transaction planning options are mutually exclusive');
    }
  }

  async run(node: FlowNodeModel, input, processor: Processor) {
    const { collection, params = {} } = node.config;

    const [dataSourceName, collectionName] = parseCollectionName(collection);

    const dataSource = this.workflow.app.dataSourceManager.dataSources.get(dataSourceName);
    const collectionManager = dataSource.collectionManager;
    const targetCollection = collectionManager.getCollection(collectionName);
    const { repository } = targetCollection;
    const options = processor.getParsedValue(params, node.id) || {};
    const baseRepositoryContext = processor.getRepositoryContext();
    const optionContext = options.context || {};
    const repositoryContext = {
      ...baseRepositoryContext,
      state: {
        ...optionContext.state,
        ...baseRepositoryContext.state,
      },
      stack: Array.from(new Set([...(baseRepositoryContext.stack || []), ...(optionContext.stack || [])])),
    };
    const processorTransaction = processor.transaction;
    let transactionOptions: WorkflowDestroyTransactionOptions | undefined;
    // Existing transactions belong to the caller and cannot be planned, replaced or upgraded here.
    if (this.transactionPlanner && !this.workflow.useDataSourceTransaction(dataSourceName, processorTransaction)) {
      const transactionDatabase = (collectionManager as { db?: { sequelize?: unknown } }).db;
      const transactionConnection = transactionDatabase?.sequelize;
      const planned = await this.transactionPlanner(
        Object.freeze({ dataSourceName, collectionName, collection: targetCollection }),
      );
      if (
        this.workflow.app.dataSourceManager.dataSources.get(dataSourceName) !== dataSource ||
        dataSource.collectionManager !== collectionManager ||
        (collectionManager as { db?: unknown }).db !== transactionDatabase ||
        transactionDatabase?.sequelize !== transactionConnection ||
        collectionManager.getCollection(collectionName) !== targetCollection
      )
        throw new TypeError('Destroy transaction target changed during planning');
      if (planned !== undefined) {
        if (
          !planned ||
          typeof planned !== 'object' ||
          ![Object.prototype, null].includes(Object.getPrototypeOf(planned))
        )
          throw new TypeError('Invalid destroy transaction options');
        transactionOptions = captureTransactionOptions(planned);
      }
    } else if (
      this.transactionOptions &&
      !this.workflow.useDataSourceTransaction(dataSourceName, processorTransaction)
    ) {
      const planned = this.transactionOptions(
        Object.freeze({
          dataSourceName,
          collectionName,
          collection: targetCollection,
          params: options,
          context: baseRepositoryContext,
        }),
      );
      if (planned !== undefined) {
        if (
          !planned ||
          typeof planned !== 'object' ||
          ![Object.prototype, null].includes(Object.getPrototypeOf(planned))
        ) {
          // Consume accidental asynchronous planners; they never become fallback or implicit default options.
          await planned;
          throw new TypeError('Invalid destroy transaction options');
        }
        transactionOptions = captureTransactionOptions(planned);
      }
    }
    const result = await withWorkflowDataSourceTransaction(
      this.workflow,
      dataSourceName,
      processorTransaction,
      async (transaction) => {
        const request: WorkflowDestroyRequest = Object.freeze({
          dataSourceName,
          collectionName,
          collection: targetCollection,
          params: options,
          context: baseRepositoryContext,
          transaction,
        });
        if (this.resolve) bindWorkflowDataOperationRequest(request, 'destroy', processor, node);
        const execute = this.resolve?.(request);
        if (execute !== undefined) {
          if (typeof execute !== 'function') {
            await execute;
            throw new TypeError('Destroy resolver must select an executor or undefined');
          }
          const destroyed = await execute(request);
          if (!Number.isSafeInteger(destroyed) || destroyed < 0) {
            throw new TypeError('Invalid destroy executor result');
          }
          return destroyed;
        }
        const repositoryOptions = await resolveTenantDestroyOptions(
          repositoryContext,
          targetCollection,
          repository,
          options,
          transaction,
        );
        const destroyed = await repository.destroy({
          ...repositoryOptions,
          context: repositoryContext,
          transaction,
        });
        if (destroyed === 0) {
          throw await workflowTenantRecordMutationMissError(
            repositoryContext,
            targetCollection,
            repository,
            options,
            transaction,
            'destroy',
          );
        }
        return destroyed;
      },
      transactionOptions,
    );

    return {
      result,
      status: JOB_STATUS.RESOLVED,
    };
  }
}

export default DestroyInstruction;

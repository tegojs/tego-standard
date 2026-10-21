import { parseCollectionName, type ICollection, type Transaction } from '@tego/server';

import { Instruction } from '.';
import { JOB_STATUS } from '../constants';
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

/**
 * Runs the destroy instruction workflow instruction.
 */
export class DestroyInstruction extends Instruction {
  constructor(
    workflow: Plugin,
    private readonly resolve?: WorkflowDestroyResolver,
  ) {
    super(workflow);
    if (resolve !== undefined && typeof resolve !== 'function') {
      throw new TypeError('Destroy resolver must be a function');
    }
  }

  async run(node: FlowNodeModel, input, processor: Processor) {
    const { collection, params = {} } = node.config;

    const [dataSourceName, collectionName] = parseCollectionName(collection);

    const targetCollection = this.workflow.app.dataSourceManager.dataSources
      .get(dataSourceName)
      .collectionManager.getCollection(collectionName);
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
    const result = await withWorkflowDataSourceTransaction(
      this.workflow,
      dataSourceName,
      processor.transaction,
      async (transaction) => {
        const request: WorkflowDestroyRequest = Object.freeze({
          dataSourceName,
          collectionName,
          collection: targetCollection,
          params: options,
          context: baseRepositoryContext,
          transaction,
        });
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
    );

    return {
      result,
      status: JOB_STATUS.RESOLVED,
    };
  }
}

export default DestroyInstruction;

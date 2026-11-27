import { DataTypes, parseCollectionName, type ICollection } from '@tego/server';

import WorkflowPlugin, { FlowNodeModel, Instruction, JOB_STATUS, Processor } from '../..';
import { applyTenantFilterToContext } from '../../helpers/tenant-context';

/** Synchronous refusal only; this grants no aggregate operation authority. */
export interface WorkflowAggregateReadRequest {
  readonly dataSourceName: string;
  readonly collectionName: string;
  readonly collection: ICollection;
  readonly params: object;
  readonly context: object;
  readonly association?: {
    readonly collectionName: string;
    readonly collection: ICollection;
    readonly name: string;
  };
}

export type WorkflowAggregateReadGuard = (request: WorkflowAggregateReadRequest) => void;

const aggregators = {
  count: 'count',
  sum: 'sum',
  avg: 'avg',
  min: 'min',
  max: 'max',
};

export default class extends Instruction {
  private readonly readGuard?: WorkflowAggregateReadGuard;

  constructor(workflow: WorkflowPlugin) {
    super(workflow);
    this.readGuard = workflow.options.aggregateGuard;
    if (this.readGuard !== undefined && typeof this.readGuard !== 'function')
      throw new TypeError('Workflow aggregate guard must be a function');
  }

  async run(node: FlowNodeModel, input, processor: Processor) {
    const { aggregator, associated, collection, association = {}, params = {} } = node.config;
    const options = processor.getParsedValue(params, node.id);
    const [dataSourceName, collectionName] = parseCollectionName(collection);
    const { collectionManager } = this.workflow.app.dataSourceManager.dataSources.get(dataSourceName);
    const targetCollection = collectionManager.getCollection(collectionName);
    const repo = associated
      ? collectionManager.getRepository(
          `${association?.associatedCollection}.${association.name}`,
          processor.getParsedValue(association?.associatedKey, node.id),
        )
      : collectionManager.getRepository(collectionName);
    const aggregateCollection = repo.collection || targetCollection;

    if (!options.dataType && aggregator === 'avg') {
      options.dataType = DataTypes.DOUBLE;
    }

    const repositoryContext = processor.getRepositoryContext();
    const repositoryOptions = applyTenantFilterToContext(repositoryContext, aggregateCollection, 'aggregate', options);
    if (this.readGuard) {
      const result: unknown = this.readGuard(
        Object.freeze({
          dataSourceName,
          collectionName: aggregateCollection.name,
          collection: aggregateCollection,
          params: repositoryOptions,
          context: repositoryContext,
          association: associated
            ? Object.freeze({
                collectionName: association.associatedCollection,
                collection: collectionManager.getCollection(association.associatedCollection),
                name: association.name,
              })
            : undefined,
        }),
      );
      if (result !== undefined) {
        await result;
        throw new TypeError('Workflow aggregate guard must return undefined synchronously');
      }
    }
    const result = await repo.aggregate({
      ...repositoryOptions,
      method: aggregators[aggregator],
      context: repositoryContext,
      transaction: this.workflow.useDataSourceTransaction(dataSourceName, processor.transaction),
    });

    return {
      result: options.dataType === DataTypes.DOUBLE ? Number(result) : result,
      status: JOB_STATUS.RESOLVED,
    };
  }
}

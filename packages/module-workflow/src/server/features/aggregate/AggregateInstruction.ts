import { DataTypes, parseCollectionName } from '@tego/server';

import { FlowNodeModel, Instruction, JOB_STATUS, Processor } from '../..';
import { applyTenantFilterToContext } from '../../helpers/tenant-context';

const aggregators = {
  count: 'count',
  sum: 'sum',
  avg: 'avg',
  min: 'min',
  max: 'max',
};

export default class extends Instruction {
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

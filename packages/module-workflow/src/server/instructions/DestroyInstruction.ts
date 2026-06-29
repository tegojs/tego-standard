import { parseCollectionName } from '@tego/server';

import { Instruction } from '.';
import { JOB_STATUS } from '../constants';
import { applyTenantFilterToContext } from '../helpers/tenant-context';
import type Processor from '../Processor';
import type { FlowNodeModel } from '../types';

export class DestroyInstruction extends Instruction {
  async run(node: FlowNodeModel, input, processor: Processor) {
    const { collection, params = {} } = node.config;

    const [dataSourceName, collectionName] = parseCollectionName(collection);

    const targetCollection = this.workflow.app.dataSourceManager.dataSources
      .get(dataSourceName)
      .collectionManager.getCollection(collectionName);
    const { repository } = targetCollection;
    const options = processor.getParsedValue(params, node.id);
    const repositoryContext = processor.getRepositoryContext();
    const repositoryOptions = applyTenantFilterToContext(repositoryContext, targetCollection, 'destroy', options);
    const result = await repository.destroy({
      ...repositoryOptions,
      context: repositoryContext,
      transaction: this.workflow.useDataSourceTransaction(dataSourceName, processor.transaction),
    });

    return {
      result,
      status: JOB_STATUS.RESOLVED,
    };
  }
}

export default DestroyInstruction;

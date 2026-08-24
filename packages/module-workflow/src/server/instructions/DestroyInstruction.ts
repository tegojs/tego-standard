import { parseCollectionName } from '@tego/server';

import { Instruction } from '.';
import { JOB_STATUS } from '../constants';
import {
  resolveTenantDestroyOptions,
  withWorkflowDataSourceTransaction,
  workflowTenantRecordUnavailableError,
} from '../helpers/tenant-context';
import type Processor from '../Processor';
import type { FlowNodeModel } from '../types';

/**
 * Runs the destroy instruction workflow instruction.
 */
export class DestroyInstruction extends Instruction {
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
          throw workflowTenantRecordUnavailableError(repositoryContext);
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

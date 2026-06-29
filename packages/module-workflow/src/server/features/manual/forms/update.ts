import { Processor } from '../../..';
import { applyTenantFilterToContext } from '../../../helpers/tenant-context';
import ManualInstruction from '../ManualInstruction';

export default async function (
  this: ManualInstruction,
  instance,
  { dataSource = 'main', collection, filter = {} },
  processor: Processor,
) {
  const ds = this.workflow.app.dataSourceManager.dataSources.get(dataSource);
  const c = ds.collectionManager.getCollection(collection);
  const repo = c.repository;
  if (!repo) {
    throw new Error(`collection ${collection} for update data on manual node not found`);
  }

  const { _, ...form } = instance.result;
  const [values] = Object.values(form);
  const repositoryContext = {
    ...processor.getRepositoryContext(),
    executionId: processor.execution.id,
  };
  const repositoryOptions = applyTenantFilterToContext(repositoryContext, c, 'update', {
    filter: processor.getParsedValue(filter, instance.nodeId),
    values: {
      ...((values as { [key: string]: any }) ?? {}),
      updatedBy: instance.userId,
    },
  });
  await repo.update({
    ...repositoryOptions,
    context: repositoryContext,
    transaction: processor.transaction,
  });
}

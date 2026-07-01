import { Processor } from '../../..';
import { applyTenantFilterToContext } from '../../../helpers/tenant-context';
import ManualInstruction from '../ManualInstruction';

export default async function (
  this: ManualInstruction,
  instance,
  { dataSource = 'main', collection },
  processor: Processor,
) {
  const ds = this.workflow.app.dataSourceManager.dataSources.get(dataSource);
  if (!ds) {
    throw new Error(`collection ${collection} for create data on manual node not found`);
  }
  const c = ds.collectionManager.getCollection(collection);
  if (!c) {
    throw new Error(`collection ${collection} for create data on manual node not found`);
  }
  const repo = c.repository;
  if (!repo) {
    throw new Error(`collection ${collection} for create data on manual node not found`);
  }

  const { _, ...form } = instance.result;
  const [values] = Object.values(form);
  const repositoryContext = {
    ...processor.getRepositoryContext(),
    executionId: processor.execution.id,
  };
  const repositoryOptions = applyTenantFilterToContext(repositoryContext, c, 'create', {
    values: {
      ...(values as { [key: string]: any }),
      createdBy: instance.userId,
      updatedBy: instance.userId,
    },
  });
  await repo.create({
    ...repositoryOptions,
    context: repositoryContext,
    transaction: processor.transaction,
  });
}

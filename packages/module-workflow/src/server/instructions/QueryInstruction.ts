import {
  DEFAULT_PAGE,
  DEFAULT_PER_PAGE,
  parseCollectionName,
  utils,
  type ICollection,
  type Transaction,
} from '@tego/server';

import { Instruction } from '.';
import { JOB_STATUS } from '../constants';
import { bindWorkflowDataOperationRequest } from '../data-operation-authority';
import { applyTenantFilterToContext } from '../helpers/tenant-context';
import type Plugin from '../Plugin';
import type Processor from '../Processor';
import type { FlowNodeModel } from '../types';
import { toJSON } from '../utils';

export interface WorkflowQueryRequest {
  readonly dataSourceName: string;
  readonly collectionName: string;
  readonly collection: ICollection;
  readonly multiple: boolean;
  readonly query: Record<string, unknown>;
  readonly context: ReturnType<Processor['getRepositoryContext']>;
  readonly transaction?: Transaction;
}

export type WorkflowQueryResult = Record<string, unknown>[] | Record<string, unknown> | null;
export type WorkflowQueryExecutor = (request: WorkflowQueryRequest) => Promise<WorkflowQueryResult>;
/** Server-only synchronous selection; the executor owns authorization and querying, including associations. */
export type WorkflowQueryResolver = (request: WorkflowQueryRequest) => WorkflowQueryExecutor | undefined;

function serializeQueryDates(value: any): any {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map(serializeQueryDates);
  }

  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializeQueryDates(item)]));
  }

  return value;
}

/**
 * Runs the query instruction workflow instruction.
 */
export class QueryInstruction extends Instruction {
  constructor(
    workflow: Plugin,
    private readonly resolve?: WorkflowQueryResolver,
  ) {
    super(workflow);
    if (resolve !== undefined && typeof resolve !== 'function') {
      throw new TypeError('Query resolver must be a function');
    }
  }

  async run(node: FlowNodeModel, input, processor: Processor) {
    const { collection, multiple, isTree, params = {}, failOnEmpty = false } = node.config;

    const otherOptions: any = {};

    if (isTree) {
      otherOptions.tree = true;
    }

    const [dataSourceName, collectionName] = parseCollectionName(collection);

    const dataSource = this.workflow.app.dataSourceManager.dataSources.get(dataSourceName);
    if (!dataSource) {
      throw new Error(`data source ${dataSourceName} for query data on query node not found`);
    }

    const targetCollection = dataSource.collectionManager.getCollection(collectionName);
    if (!targetCollection?.repository) {
      throw new Error(`collection ${collectionName} repository for query data on query node not found`);
    }

    const { repository } = targetCollection;
    const {
      page,
      pageSize,
      sort = [],
      paginate = true,
      ...options
    } = serializeQueryDates(processor.getParsedValue(params, node.id));

    const appends = options.appends
      ? Array.from(
          options.appends.reduce((set, field) => {
            set.add(field.split('.')[0]);
            set.add(field);
            return set;
          }, new Set()),
        )
      : options.appends;

    const pageArgs = paginate ? utils.pageArgsToLimitArgs(page || DEFAULT_PAGE, pageSize || DEFAULT_PER_PAGE) : {};
    const repositoryContext = processor.getRepositoryContext();
    const query = {
      ...options,
      ...otherOptions,
      ...pageArgs,
      sort: sort
        .filter((item) => item.field)
        .map((item) => `${item.direction?.toLowerCase() === 'desc' ? '-' : ''}${item.field}`),
      appends,
    };
    const request: WorkflowQueryRequest = Object.freeze({
      dataSourceName,
      collectionName,
      collection: targetCollection,
      multiple: !!multiple,
      query,
      context: repositoryContext,
      transaction: this.workflow.useDataSourceTransaction(dataSourceName, processor.transaction),
    });
    if (this.resolve) bindWorkflowDataOperationRequest(request, 'list', processor, node);
    const execute = this.resolve?.(request);
    let result;
    if (execute === undefined) {
      const repositoryOptions = applyTenantFilterToContext(repositoryContext, targetCollection, 'list', query);
      result = await (multiple ? repository.find : repository.findOne).call(repository, {
        ...repositoryOptions,
        context: repositoryContext,
        transaction: request.transaction,
      });
    } else {
      if (typeof execute !== 'function') {
        // Consume rejected asynchronous selections without accepting them or falling back.
        await execute;
        throw new TypeError('Query resolver must select an executor or undefined');
      }
      result = await execute(request);
      if (
        multiple ? !Array.isArray(result) : result !== null && (typeof result !== 'object' || Array.isArray(result))
      ) {
        throw new TypeError('Invalid query executor result');
      }
    }

    if (failOnEmpty && (multiple ? !result.length : !result)) {
      return {
        result,
        status: JOB_STATUS.FAILED,
      };
    }

    // NOTE: `toJSON()` to avoid getting undefined value from Proxied model instance (#380)
    // e.g. Object.prototype.hasOwnProperty.call(result, 'id') // false
    // so the properties can not be get by json-templates(object-path)
    return {
      result: toJSON(result),
      status: JOB_STATUS.RESOLVED,
    };
  }
}

export default QueryInstruction;

import { DEFAULT_PAGE, DEFAULT_PER_PAGE, parseCollectionName, utils } from '@tego/server';

import { isArray } from 'lodash';

import Instruction from '.';
import { JOB_STATUS } from '../constants';
import { bindWorkflowDataOperationRequest } from '../data-operation-authority';
import { applyTenantFilterToContext } from '../helpers/tenant-context';
import type Plugin from '../Plugin';
import type Processor from '../Processor';
import type { FlowNodeModel } from '../types';
import { toJSON } from '../utils';
import type { WorkflowQueryRequest, WorkflowQueryResolver } from './QueryInstruction';

/**
 * Runs the select instruction workflow instruction.
 */
export class SelectInstruction extends Instruction {
  constructor(
    workflow: Plugin,
    private readonly resolve?: WorkflowQueryResolver,
  ) {
    super(workflow);
    if (resolve !== undefined && typeof resolve !== 'function') {
      throw new TypeError('Select resolver must be a function');
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
      throw new Error(`data source ${dataSourceName} for select data on select node not found`);
    }

    const targetCollection = dataSource.collectionManager.getCollection(collectionName);
    if (!targetCollection?.repository) {
      throw new Error(`collection ${collectionName} repository for select data on select node not found`);
    }

    const { repository, fields } = targetCollection;
    const { page, pageSize, sort = [], paginate = true, ...options } = processor.getParsedValue(params, node.id);

    const appends = options.summary?.includes('.') ? [options.summary] : [];
    if (options.summary && !options.summary?.includes('.')) {
      if (['belongsTo', 'hasOne', 'hasMany', 'belongsToMany'].includes(fields.get(options.summary)?.type)) {
        appends.push(options.summary);
      }
    }

    let pageArgs = paginate ? utils.pageArgsToLimitArgs(page || DEFAULT_PAGE, pageSize || DEFAULT_PER_PAGE) : {};
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
    const { summary: summaryOption, ...readQuery } = query;
    const request: WorkflowQueryRequest = Object.freeze({
      dataSourceName,
      collectionName,
      collection: targetCollection,
      multiple: !!multiple,
      query: readQuery,
      context: repositoryContext,
      transaction: this.workflow.useDataSourceTransaction(dataSourceName, processor.transaction),
    });
    if (this.resolve) bindWorkflowDataOperationRequest(request, 'list', processor, node);
    const execute = this.resolve?.(request);
    let data;
    if (execute === undefined) {
      const repositoryOptions = applyTenantFilterToContext(repositoryContext, targetCollection, 'list', query);
      data = await (multiple ? repository.find : repository.findOne).call(repository, {
        ...repositoryOptions,
        context: repositoryContext,
        transaction: request.transaction,
      });
    } else {
      if (typeof execute !== 'function') {
        await execute;
        throw new TypeError('Select resolver must select an executor or undefined');
      }
      data = await execute(request);
      if (multiple ? !Array.isArray(data) : data !== null && (typeof data !== 'object' || Array.isArray(data))) {
        throw new TypeError('Invalid select executor result');
      }
    }

    let result;
    const summary = summaryOption?.length ? summaryOption.split('.') : null;
    if (summary) {
      if (isArray(data)) {
        result = [];
        data.forEach((item) => {
          const filteredValue = findField(item, summary[0], 0, summary, multiple, true);
          const value = isArray(filteredValue) ? filteredValue : [filteredValue];
          result.push(...value);
        });
      } else {
        result = findField(data, summary[0], 0, summary, multiple, true);
      }

      result = isArray(result) ? (multiple ? result : result[0]) : result;
    }

    if (failOnEmpty && (multiple ? !data.length : !data)) {
      return {
        result: summary ? result : data,
        status: JOB_STATUS.FAILED,
      };
    }

    // NOTE: `toJSON()` to avoid getting undefined value from Proxied model instance (#380)
    // e.g. Object.prototype.hasOwnProperty.call(result, 'id') // false
    // so the properties can not be get by json-templates(object-path)
    return {
      result: toJSON(summary ? result : data),
      status: JOB_STATUS.RESOLVED,
    };
  }
}

export default SelectInstruction;

const findField = (record, field, index, summary, multiple, isOne) => {
  if (record == null) {
    return undefined;
  }
  if (!multiple && !isOne) {
    return;
  }
  let isOneField = isOne;
  const current = record[field];

  if (index === summary.length - 1) {
    if (!multiple && isOne) {
      isOneField = false;
    }
    return current;
  }
  const nextField = summary[index + 1];

  if (Array.isArray(current)) {
    const results = [];
    current.forEach((item) => {
      const v = findField(item, nextField, index + 1, summary, multiple, isOneField);
      if (v === undefined) return;
      results.push(v);
    });
    return results;
  }

  return findField(current, nextField, index + 1, summary, multiple, isOneField);
};

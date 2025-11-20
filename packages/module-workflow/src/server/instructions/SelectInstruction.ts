import { DEFAULT_PAGE, DEFAULT_PER_PAGE, parseCollectionName, utils } from '@tego/server';

import { isArray } from 'lodash';

import Instruction from '.';
import { JOB_STATUS } from '../constants';
import type Processor from '../Processor';
import type { FlowNodeModel } from '../types';
import { toJSON } from '../utils';

export class SelectInstruction extends Instruction {
  async run(node: FlowNodeModel, input, processor: Processor) {
    const { collection, multiple, isTree, params = {}, failOnEmpty = false } = node.config;

    const otherOptions: any = {};

    if (isTree) {
      otherOptions.tree = true;
    }

    const [dataSourceName, collectionName] = parseCollectionName(collection);

    const { repository } = this.workflow.app.dataSourceManager.dataSources
      .get(dataSourceName)
      .collectionManager.getCollection(collectionName);
    const { page, pageSize, sort = [], paginate = true, ...options } = processor.getParsedValue(params, node.id);

    const appends = options.summary?.includes('.') ? [options.summary] : [];

    let pageArgs = paginate ? utils.pageArgsToLimitArgs(page, pageSize) : {};
    const data = await (multiple ? repository.find : repository.findOne).call(repository, {
      ...options,
      ...otherOptions,
      ...pageArgs,
      sort: sort
        .filter((item) => item.field)
        .map((item) => `${item.direction?.toLowerCase() === 'desc' ? '-' : ''}${item.field}`),
      appends,
      transaction: this.workflow.useDataSourceTransaction(dataSourceName, processor.transaction),
    });

    let result;
    const summary = options.summary?.length ? options.summary.split('.') : null;
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

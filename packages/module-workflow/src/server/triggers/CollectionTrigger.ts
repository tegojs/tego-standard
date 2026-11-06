import { ICollection, Model, parseCollectionName, Transactionable } from '@tego/server';

import Trigger from '.';
import { getCurrentTenantIdFromState } from '../helpers/tenant-context';
import type WorkflowPlugin from '../Plugin';
import type { WorkflowModel } from '../types';
import { toJSON } from '../utils';

export interface CollectionChangeTriggerConfig {
  collection: string;
  mode: number;
  // TODO: ICondition
  condition: any;
}

export interface WorkflowCollectionReadRequest {
  readonly dataSourceName: string;
  readonly collectionName: string;
  readonly collection: ICollection;
  readonly params: object;
  readonly context: object;
}

/** Synchronous refusal only; an event does not grant business read authority. */
export type WorkflowCollectionReadGuard = (request: WorkflowCollectionReadRequest) => void;

async function assertReadBoundary(
  guard: WorkflowCollectionReadGuard | undefined,
  request: WorkflowCollectionReadRequest,
) {
  if (!guard) return;
  const result: unknown = guard(Object.freeze(request));
  if (result !== undefined) {
    await result;
    throw new TypeError('Workflow collection read guard must return undefined synchronously');
  }
}

const MODE_BITMAP = {
  CREATE: 1,
  UPDATE: 2,
  DESTROY: 4,
};

const MODE_BITMAP_EVENTS = new Map();
MODE_BITMAP_EVENTS.set(MODE_BITMAP.CREATE, 'afterCreateWithAssociations');
MODE_BITMAP_EVENTS.set(MODE_BITMAP.UPDATE, 'afterUpdateWithAssociations');
MODE_BITMAP_EVENTS.set(MODE_BITMAP.DESTROY, 'afterDestroy');

function getHookId(workflow, type) {
  return `${type}#${workflow.id}`;
}

function getFieldRawName(collection: ICollection, name: string) {
  const field = collection.getField(name);
  if (field && field.options.type === 'belongsTo') {
    return field.options.foreignKey;
  }
  return name;
}

function pickTenantState(state: Record<string, any> = {}, fallbackTenantId?: string | number | null) {
  const currentTenantId = getCurrentTenantIdFromState(state) ?? fallbackTenantId;

  if (currentTenantId === null || currentTenantId === undefined) {
    return undefined;
  }

  return {
    currentTenant: state.currentTenant,
    currentTenantId,
    currentTenantDescendantIds: state.currentTenantDescendantIds || [],
    currentTenancyMode: state.currentTenancyMode,
    currentLegacyDataTenantIds: state.currentLegacyDataTenantIds || [],
  };
}

// async function, should return promise
async function handler(
  this: CollectionTrigger,
  readGuard: WorkflowCollectionReadGuard | undefined,
  workflow: WorkflowModel,
  isCurrent: () => boolean,
  data: Model,
  options,
) {
  if (!isCurrent()) {
    return;
  }
  const { condition, changed, mode, appends, blacklist } = workflow.config;
  const [dataSourceName, collectionName] = parseCollectionName(workflow.config.collection);
  const collection = this.workflow.app.dataSourceManager?.dataSources
    .get(dataSourceName)
    .collectionManager.getCollection(collectionName);
  const { transaction, context } = options;
  const { repository, filterTargetKey } = collection;

  // NOTE: if no configured fields changed, do not trigger
  if (
    changed &&
    changed.length &&
    changed
      .filter(
        (name) => !['linkTo', 'hasOne', 'hasMany', 'belongsToMany'].includes(collection.getField(name).options.type),
      )
      .every((name) => !data.changedWithAssociations(getFieldRawName(collection, name)))
  ) {
    return;
  }

  if (blacklist && blacklist.length) {
    const changedWithAssociations = data.changedWithAssociations() as string[];
    // 系统字段
    const presetFields = ['createdBy', 'createdById', 'createdAt', 'updatedBy', 'updatedById', 'updatedAt'];
    if (changedWithAssociations) {
      // exclude system fields
      const userFields = changedWithAssociations.filter(
        (field) =>
          !presetFields.includes(field) &&
          collection.getField(field) &&
          !['linkTo', 'hasOne', 'hasMany', 'belongsToMany'].includes(collection.getField(field).options.type),
      );
      const allInBlacklist = userFields.every((name) => blacklist.includes(name));
      if (allInBlacklist) {
        return;
      }
    }
  }
  // NOTE: if no configured condition match, do not trigger
  if (condition && condition.$and?.length) {
    // TODO: change to map filter format to calculation format
    // const calculation = toCalculation(condition);
    const params = {
      filter: {
        $and: [condition, { [filterTargetKey]: data[filterTargetKey] }],
      },
    };
    await assertReadBoundary(readGuard, { dataSourceName, collectionName, collection, params, context });
    const count = await repository.count({
      ...params,
      context,
      transaction,
    });

    if (!count) {
      return;
    }
  }

  let result = data;

  if (appends?.length && !(mode & MODE_BITMAP.DESTROY)) {
    const includeFields = appends.reduce((set, field) => {
      set.add(field.split('.')[0]);
      set.add(field);
      return set;
    }, new Set());
    const params = {
      filterByTk: data[filterTargetKey],
      appends: Array.from(includeFields),
    };
    await assertReadBoundary(readGuard, { dataSourceName, collectionName, collection, params, context });
    result = await repository.findOne({
      ...params,
      context,
      transaction,
    });
  }

  if (!isCurrent()) {
    return;
  }

  // TODO: `result.toJSON()` throws error
  const json = toJSON(result);
  const fallbackTenantId = json && !Array.isArray(json) ? json.tenantId : undefined;
  const state = pickTenantState(context?.state, fallbackTenantId);
  const triggerContext = state ? { data: json, stack: context?.stack, state } : { data: json, stack: context?.stack };
  const triggerOptions = {
    context: state
      ? {
          ...context,
          state: { ...context?.state, ...state },
        }
      : context,
  };

  if (workflow.sync) {
    await this.workflow.trigger(workflow, triggerContext, {
      ...triggerOptions,
      transaction: this.workflow.useDataSourceTransaction(dataSourceName, transaction),
    });
  } else {
    this.workflow.trigger(workflow, triggerContext, triggerOptions);
  }
}

export default class CollectionTrigger extends Trigger {
  events = new Map();
  private readonly readGuard?: WorkflowCollectionReadGuard;

  constructor(workflow: WorkflowPlugin) {
    super(workflow);
    this.readGuard = workflow.options.collectionReadGuard;
    if (this.readGuard !== undefined && typeof this.readGuard !== 'function')
      throw new TypeError('Workflow collection read guard must be a function');
  }

  on(workflow: WorkflowModel) {
    const { collection, mode } = workflow.config;
    if (!collection) {
      return;
    }
    const [dataSourceName, collectionName] = parseCollectionName(collection);
    // @ts-ignore
    const { db } = this.workflow.app.dataSourceManager?.dataSources.get(dataSourceName)?.collectionManager ?? {};
    if (!db || !db.getCollection(collectionName)) {
      return;
    }

    for (const [key, type] of MODE_BITMAP_EVENTS.entries()) {
      const event = `${collectionName}.${type}`;
      const name = getHookId(workflow, `${collection}.${type}`);
      if (mode & key) {
        if (!this.events.has(name)) {
          const listener = handler.bind(this, this.readGuard, workflow, () => this.events.get(name) === listener);
          this.events.set(name, listener);
          db.on(event, listener);
        }
      } else {
        const listener = this.events.get(name);
        if (listener) {
          db.off(event, listener);
          this.events.delete(name);
        }
      }
    }
  }

  off(workflow: WorkflowModel) {
    const { collection, mode } = workflow.config;
    if (!collection) {
      return;
    }
    const [dataSourceName, collectionName] = parseCollectionName(collection);
    // @ts-ignore
    const { db } = this.workflow.app.dataSourceManager.dataSources.get(dataSourceName)?.collectionManager ?? {};
    if (!db || !db.getCollection(collectionName)) {
      return;
    }

    for (const [key, type] of MODE_BITMAP_EVENTS.entries()) {
      const name = getHookId(workflow, `${collection}.${type}`);
      if (mode & key) {
        const listener = this.events.get(name);
        if (listener) {
          db.off(`${collectionName}.${type}`, listener);
          this.events.delete(name);
        }
      }
    }
  }

  async validateEvent(workflow: WorkflowModel, context: any, options: Transactionable): Promise<boolean> {
    if (context.stack) {
      const existed = await workflow.countExecutions({
        where: {
          id: context.stack,
        },
        transaction: options.transaction,
      });

      if (existed) {
        this.workflow
          .getLogger(workflow.id)
          .warn(
            `workflow ${workflow.id} has already been triggered in stack executions (${context.stack}), and newly triggering will be skipped.`,
          );

        return false;
      }
    }

    return true;
  }
}

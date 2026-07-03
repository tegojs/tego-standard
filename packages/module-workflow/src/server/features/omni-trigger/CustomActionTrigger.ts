import PluginErrorHandler from '@tachybase/module-error-handler';
import { Context, joinCollectionName, Model, modelAssociationByKey, Next, parseCollectionName } from '@tego/server';

import _, { get, isArray } from 'lodash';

import { EXECUTION_STATUS } from '../../constants';
import { applyTenantFilterToContext } from '../../helpers/tenant-context';
import Trigger from '../../triggers';
import { toJSON } from '../../utils';

class CustomActionInterceptionError extends Error {
  status = 400;
  messages = [];
  constructor(message) {
    super(message);
    this.name = 'CustomActionInterceptionError';
  }
}

function isEmptyLookupResult(data: any) {
  return !data || (Array.isArray(data) && data.length === 0);
}

function mergeFormData(data: any, formData: any) {
  if (Array.isArray(data)) {
    data.forEach((item) => Object.assign(item, formData));
    return data;
  }

  Object.assign(data, formData);
  return data;
}

export class OmniTrigger extends Trigger {
  static TYPE = 'general-action';
  constructor(workflow) {
    super(workflow);
    const errorHandlerPlugin = (this.workflow.app.pm.get('error-handler') ||
      this.workflow.app.pm.get(PluginErrorHandler)) as InstanceType<typeof PluginErrorHandler> | undefined;
    if (!errorHandlerPlugin?.errorHandler) {
      throw new Error('Workflow omni trigger requires the error-handler plugin');
    }
    this.workflow.app.resourcer.registerActionHandler('trigger', this.triggerAction);
    this.workflow.app.acl.allow('*', 'trigger', 'loggedIn');
    errorHandlerPlugin.errorHandler.register(
      (err) => err instanceof CustomActionInterceptionError,
      async (err, ctx) => {
        ctx.body = {
          errors: err.messages,
        };
        ctx.status = err.status;
      },
    );
    workflow.app.resourcer.use(this.middleware, { tag: 'workflowTrigger', after: 'acl' });
  }
  triggerAction = async (ctx, next) => {
    const {
      params: { filterByTk, values, triggerWorkflows = '', filter, resourceName, actionName },
    } = ctx.action;

    if (actionName !== 'trigger' || resourceName === 'workflows') {
      return next();
    }
    const { currentUser, currentRole } = ctx.state;
    const { model: UserModel } = this.workflow.db.getCollection('users');
    const userInfo = {
      user: UserModel.build(currentUser).desensitize(),
      roleName: currentRole,
    };
    const dataSourceHeader = ctx.get('x-data-source');
    const jointCollectionName = joinCollectionName(dataSourceHeader, resourceName);
    const triggerWorkflowsMap = new Map();
    const triggerWorkflowsArray = [];
    for (const trigger of triggerWorkflows.split(',')) {
      const [key, path] = trigger.split('!');
      triggerWorkflowsMap.set(key, path);
      triggerWorkflowsArray.push(key);
    }
    const workflows = Array.from(this.workflow.enabledCache.values())
      .filter(
        (item) =>
          item.type === OmniTrigger.TYPE &&
          item.config.collection === jointCollectionName &&
          triggerWorkflowsArray.includes(item.key),
      )
      .sort((a, b) => {
        const aIndex = triggerWorkflowsArray.indexOf(a.key);
        const bIndex = triggerWorkflowsArray.indexOf(b.key);
        if (aIndex === -1 && bIndex === -1) {
          return a.id - b.id;
        }
        if (aIndex === -1) {
          return 1;
        }
        if (bIndex === -1) {
          return -1;
        }
        return aIndex - bIndex;
      });
    const syncGroup = [];
    const asyncGroup = [];
    for (const workflow of workflows) {
      const { appends = [] } = workflow.config;
      const [dataSourceName, collectionName] = parseCollectionName(workflow.config.collection);
      const dataPath = triggerWorkflowsMap.get(workflow.key);
      const event = [workflow];
      const targetCollection = ctx.tego.dataSourceManager.dataSources
        .get(dataSourceName)
        .collectionManager.getCollection(collectionName);
      const { repository } = targetCollection;
      const formData = dataPath ? _.get(values, dataPath) : values;
      let data = formData;
      if (filterByTk != null) {
        const findOptions = applyTenantFilterToContext(ctx, targetCollection, 'list', {
          filterByTk,
          appends,
        });
        if (isArray(filterByTk)) {
          data = await repository.find({ ...findOptions, context: ctx });
        } else {
          data = await repository.findOne({ ...findOptions, context: ctx });
        }
        if (isEmptyLookupResult(data)) {
          continue;
        }
        data = mergeFormData(data, formData);
      } else if (filter != null) {
        const findOptions = applyTenantFilterToContext(ctx, targetCollection, 'list', {
          filter,
          appends,
        });
        data = await repository.find({ ...findOptions, context: ctx });
        if (isEmptyLookupResult(data)) {
          continue;
        }
        data = mergeFormData(data, formData);
      }
      // @ts-ignore
      event.push({ data: toJSON(data), ...userInfo });
      (workflow.sync ? syncGroup : asyncGroup).push(event);
    }
    for (const event of syncGroup) {
      const processor = await this.workflow.trigger(event[0], event[1], { httpContext: ctx });
      if (!processor) {
        return ctx.throw(500);
      }
      const { lastSavedJob, nodesMap } = processor;
      const lastNode = nodesMap.get(lastSavedJob?.nodeId);
      if (processor.execution.status === EXECUTION_STATUS.RESOLVED) {
        if (lastNode?.type === 'end') {
          return;
        }
        continue;
      }
      if (processor.execution.status < EXECUTION_STATUS.STARTED) {
        if (lastNode?.type !== 'end') {
          return ctx.throw(
            500,
            ctx.t('Workflow on your action failed, please contact the administrator', { ns: 'workflow' }),
          );
        }
        const err = new CustomActionInterceptionError('Request is intercepted by workflow');
        err.status = 400;
        err.messages = ctx.state.messages;
        return ctx.throw(err.status, err);
      }
      return ctx.throw(500, 'Workflow on your action hangs, please contact the administrator');
    }
    for (const event of asyncGroup) {
      this.workflow.trigger(event[0], event[1], { httpContext: ctx });
    }
    await next();
  };

  middleware = async (ctx: Context, next: Next) => {
    const {
      resourceName,
      actionName,
      params: { triggerWorkflows, beforeWorkflows },
    } = ctx.action;

    if (beforeWorkflows) {
      await this.trigger(ctx, beforeWorkflows, 'before');
    }

    if (resourceName === 'workflows' && actionName === 'trigger') {
      return this.triggerAction(ctx, next);
    }

    await next();

    if (!triggerWorkflows) {
      return;
    }

    if (!['create', 'update'].includes(actionName)) {
      return;
    }

    // TODO: 此处如果执行错误应该怎么办
    return this.trigger(ctx, triggerWorkflows);
  };

  private async trigger(ctx: Context, workflowList: string, order: 'after' | 'before' = 'after') {
    if (!workflowList) {
      return;
    }
    const { values } = ctx.action.params;
    const dataSourceHeader = ctx.get('x-data-source') || 'main';

    const { currentUser, currentRole } = ctx.state;
    const { model: UserModel } = this.workflow.db.getCollection('users');
    const userInfo = {
      user: UserModel.build(currentUser).desensitize(),
      roleName: currentRole,
    };

    const triggers = workflowList.split(',').map((trigger) => trigger.split('!'));
    const workflowRepo = this.workflow.db.getRepository('workflows');
    const workflows = (
      await workflowRepo.find({
        filter: {
          key: triggers.map((trigger) => trigger[0]),
          current: true,
          type: 'general-action',
          enabled: true,
        },
      })
    ).filter((workflow) => Boolean(workflow.config.collection));
    const syncGroup = [];
    const asyncGroup = [];
    for (const workflow of workflows) {
      const { collection, appends = [] } = workflow.config;
      const [dataSourceName, collectionName] = parseCollectionName(collection);
      const trigger = triggers.find((trigger) => trigger[0] === workflow.key);
      const event = [workflow];
      if (ctx.action.resourceName !== 'workflows') {
        if (order === 'before') {
          event.push({ data: ctx.action.params, ...userInfo });
          (workflow.sync ? syncGroup : asyncGroup).push(event);
          continue;
        }
        if (!ctx.body) {
          continue;
        }
        if (dataSourceName !== dataSourceHeader) {
          continue;
        }
        const { body: data } = ctx;
        for (const row of Array.isArray(data) ? data : [data]) {
          let payload = row;
          if (trigger[1]) {
            const paths = trigger[1].split('.');
            for (const field of paths) {
              if (payload.get(field)) {
                payload = payload.get(field);
              } else {
                const association: any = modelAssociationByKey(payload, field);
                payload = await payload[association.accessors.get]();
              }
            }
          }
          const model = payload.constructor;
          if (payload instanceof Model) {
            if (collectionName !== model.collection.name) {
              continue;
            }
            if (appends.length) {
              const findOptions = applyTenantFilterToContext(ctx, model.collection, 'list', {
                filterByTk: payload.get(model.primaryKeyAttribute),
                appends,
              });
              payload = await model.collection.repository.findOne({
                ...findOptions,
                context: ctx,
              });
              if (isEmptyLookupResult(payload)) {
                continue;
              }
            }
          }
          // this.workflow.trigger(workflow, { data: toJSON(payload), ...userInfo });
          event.push({ data: toJSON(payload), ...userInfo });
        }
      } else {
        const targetCollection = (<any>ctx.tego).dataSourceManager.dataSources
          .get(dataSourceName)
          .collectionManager.getCollection(collectionName);
        const { model, repository } = targetCollection;
        let data = trigger[1] ? get(values, trigger[1]) : values;
        const pk = get(data, model.primaryKeyAttribute);
        if (appends.length && pk != null) {
          const findOptions = applyTenantFilterToContext(ctx, targetCollection, 'list', {
            filterByTk: pk,
            appends,
          });
          data = await repository.findOne({
            ...findOptions,
            context: ctx,
          });
          if (isEmptyLookupResult(data)) {
            continue;
          }
        }
        // this.workflow.trigger(workflow, {
        //   data,
        //   ...userInfo,
        // });
        event.push({ data, ...userInfo });
      }
      (workflow.sync ? syncGroup : asyncGroup).push(event);
    }

    for (const event of syncGroup) {
      await this.workflow.trigger(event[0], event[1], { httpContext: ctx });
    }

    for (const event of asyncGroup) {
      this.workflow.trigger(event[0], event[1], { httpContext: ctx });
    }
  }

  on() {}
  off() {}
}

import path from 'node:path';
import { Context, Gateway, Next, Plugin, Registry, WSServer } from '@tego/server';

import { EVENT_SOURCE_COLLECTION, EVENT_SOURCE_REALTIME } from '../constants';
import { EventSourceModel } from '../model/EventSourceModel';
import { WebhookCategories } from '../model/WebhookCategories';
import { AppEventTrigger } from '../trigger/AppEventTrigger';
import { CustomActionTrigger } from '../trigger/CustomctionTrigger';
import { DatabaseEventTrigger } from '../trigger/DatabaseEventTrigger';
import { ResourceEventTrigger } from '../trigger/ResourceEventTrigger';
import { EventSourceTrigger } from '../trigger/Trigger';
import { WebhookController } from './webhooks';

export class PluginWebhook extends Plugin {
  triggers: Registry<EventSourceTrigger> = new Registry();
  ws: WSServer;

  refreshRealTime: boolean = EVENT_SOURCE_REALTIME;
  changed: boolean = false;

  async beforeLoad() {
    this.app.db.registerModels({
      EventSourceModel: EventSourceModel,
      WebhookCategories: WebhookCategories,
    });
  }

  async load() {
    // 如果基类的 loadCollections() 没有导入 collections（packageName 未设置），手动导入
    const collectionsDir = path.resolve(__dirname, '../collections');
    const webhooksCollection = this.db.getCollection(EVENT_SOURCE_COLLECTION);
    if (!webhooksCollection) {
      await this.db.import({
        directory: collectionsDir,
        from: this.options.packageName || '@tachybase/module-event-source',
      });
    }

    const gateway = Gateway.getInstance();
    this.ws = gateway['wsServer'];

    this.app.resourcer.define({
      name: 'webhooks',
      actions: {
        trigger: new WebhookController().getLink,
        test: new WebhookController().test,
      },
    });
    // TODO: 这个权限可能需要重新设计
    this.app.acl.allow('webhooks', ['trigger', 'test'], 'loggedIn');

    this.app.resourcer.use(
      async (ctx: Context, next: Next) => {
        await next();
        const { resourceName, actionName } = ctx.action;
        if (resourceName === 'webhooks') {
          if (actionName === 'list') {
            const rows = ctx.body.rows as EventSourceModel[];
            rows.forEach((model) => {
              const trigger = this.triggers.get(model.type);
              if (!trigger) {
                model.effect = true;
              } else {
                model.effect = trigger.getEffect(model);
              }
            });
            ctx.body.changed = this.changed;
          } else if (actionName === 'get') {
            const model = ctx.body as EventSourceModel;
            const trigger = this.triggers.get(model.type);
            if (trigger) {
              model.effectConfig = trigger.getEffectConfig(model.id);
            }
          }
        }
      },
      { tag: 'webhooks-show-effect' },
    );

    this.triggers.register('resource', new CustomActionTrigger(this.app, this.refreshRealTime));
    this.triggers.register('beforeResource', new ResourceEventTrigger(this.app, this.refreshRealTime));
    this.triggers.register('afterResource', new ResourceEventTrigger(this.app, this.refreshRealTime));
    this.triggers.register('applicationEvent', new AppEventTrigger(this.app, this.refreshRealTime));
    this.triggers.register('databaseEvent', new DatabaseEventTrigger(this.app, this.refreshRealTime));

    await this.db.sync();
    await this.loadEventSources();

    this.app.acl.registerSnippet({
      name: 'pm.business-components.event-source',
      actions: ['webhooks:*', 'workflows:*', 'webhookCategories:*'],
    });
  }

  async loadEventSources() {
    const collection = this.db.getCollection(EVENT_SOURCE_COLLECTION);
    if (!collection) {
      this.app.logger.warn(`Collection ${EVENT_SOURCE_COLLECTION} is not defined`);
      return;
    }

    const repo = collection.repository;
    if (!repo) {
      this.app.logger.warn(`Repository for ${EVENT_SOURCE_COLLECTION} is not available`);
      return;
    }

    const list = (await repo.find({
      filter: {
        enabled: true,
      },
    })) as EventSourceModel[];
    for (const item of list) {
      const trigger = this.triggers.get(item.type);
      trigger?.load(item);
      trigger?.workSetAdd(item.id);
      trigger?.effectConfigSet(item.id, item.toJSON());
    }

    for (const trigger of this.triggers.getValues()) {
      await trigger.afterAllLoad();
    }

    this.db.on(`${EVENT_SOURCE_COLLECTION}.afterCreate`, async (model: EventSourceModel) => {
      const trigger = this.triggers.get(model.type);
      if (!trigger?.getRealTimeRefresh()) {
        if (model.enabled) {
          this.changed = true;
        }
        return;
      }
      if (model.enabled) {
        await trigger.afterCreate(model);
        trigger.workSetAdd(model.id);
        trigger.effectConfigSet(model.id, model.toJSON());
      }
      this.ws.sendToConnectionsByTag('app', this.app.name, {
        type: 'maintaining',
        payload: {
          message: `finish create: ${model.name}`,
          code: 'APP_COMMANDING',
          command: {
            name: 'refreshEventSource',
          },
        },
      });
    });

    this.db.on(`${EVENT_SOURCE_COLLECTION}.beforeUpdate`, async (model: EventSourceModel, options) => {
      const trigger = this.triggers.get(model.type);
      if (!trigger?.getRealTimeRefresh()) {
        return;
      }
      // 修改了type的情况
      if (options.values.type && options.values.type !== model.type) {
        await trigger.afterDestroy(model);
        trigger.workSetDelete(model.id);
      }
    });

    this.db.on(`${EVENT_SOURCE_COLLECTION}.afterUpdate`, async (model: EventSourceModel, options) => {
      const trigger = this.triggers.get(model.type);
      if (!trigger?.getRealTimeRefresh()) {
        for (const key of ['enabled', 'type', 'options', 'code', 'workflowKey']) {
          if (model.changed(key)) {
            this.changed = true;
            break;
          }
        }
        return;
      }
      await trigger.afterUpdate(model);
      trigger.effectConfigSet(model.id, model.toJSON());
      this.ws.sendToConnectionsByTag('app', this.app.name, {
        type: 'maintaining',
        payload: {
          message: `update successfully: ${model.name}`,
          code: 'APP_COMMANDING',
          command: {
            name: 'refreshEventSource',
          },
        },
      });
      // 修改了type的情况
      if (options.values.type && options.values.type !== model.type) {
        await trigger.afterCreate(model);
        trigger.workSetAdd(model.id);
        return;
      }
      if (model.enabled) {
        trigger?.workSetAdd(model.id);
      } else {
        trigger?.workSetDelete(model.id);
      }
    });

    this.db.on(`${EVENT_SOURCE_COLLECTION}.afterDestroy`, async (model: EventSourceModel) => {
      const trigger = this.triggers.get(model.type);
      if (!trigger?.getRealTimeRefresh()) {
        if (model.enabled) {
          this.changed = true;
        }
        return;
      }
      await trigger.afterDestroy(model);
      trigger.workSetDelete(model.id);
      this.ws.sendToConnectionsByTag('app', this.app.name, {
        type: 'maintaining',
        payload: {
          message: `destroy successfully: ${model.name}`,
          code: 'APP_COMMANDING',
          command: {
            name: 'refreshEventSource',
          },
        },
      });
    });
  }
}

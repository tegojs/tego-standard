import { isMainThread } from 'node:worker_threads';
import { Context, InjectedPlugin, Plugin, type Collection, type PluginOptions } from '@tego/server';

import { TrackingController } from './actions/tracking-controller';
import { handleOtherAction } from './hooks/afterAction';
import { ServerTrackingFilter } from './ServerTrackingFilter';

/** Refusal only: this does not grant authority to execute a business-table aggregate. */
export interface InstrumentationCollectionCountRequest {
  readonly dataSourceName: 'main';
  readonly collectionName: string;
  readonly collection: Collection;
  readonly params: object;
  readonly context: Context;
}

export type InstrumentationCollectionCountGuard = (request: InstrumentationCollectionCountRequest) => void;

export interface InstrumentationPluginOptions extends PluginOptions {
  /** Explicit server bootstrap only; no selected-table aggregate executor is installed here. */
  collectionCountGuard?: InstrumentationCollectionCountGuard;
}

@InjectedPlugin({
  Controllers: [TrackingController],
})
export class ModuleInstrumentationServer extends Plugin {
  declare options: InstrumentationPluginOptions;
  private collectionCountGuard?: InstrumentationCollectionCountGuard;
  serverTrackingFilter: ServerTrackingFilter = null;

  async beforeLoad() {
    const guard = this.options.collectionCountGuard;
    if (guard !== undefined && typeof guard !== 'function')
      throw new TypeError('Instrumentation collection count guard must be a function');
    this.collectionCountGuard = guard;
  }

  assertCollectionCount(request: InstrumentationCollectionCountRequest) {
    if (!this.collectionCountGuard) return;
    const result: unknown = this.collectionCountGuard(request);
    if (result !== undefined) {
      return Promise.resolve(result).then(() => {
        throw new TypeError('Instrumentation collection count guard must return undefined synchronously');
      });
    }
  }

  async addServerTrackingListener() {
    this.app.on('afterStart', async () => {
      const SignInTracking = await this.app.db.getRepository('trackingConfig').findOne({
        filter: {
          title: 'sign-in',
          resourceName: 'auth',
          action: 'signIn',
        },
      });
      if (!SignInTracking) {
        await this.app.db.getRepository('trackingConfig').create({
          values: {
            title: 'sign-in',
            resourceName: 'auth',
            action: 'signIn',
            trackingOptions: {
              meta: ['userId', 'recordId', 'createdAt', 'user-agent'],
              filter: {
                $and: [
                  {
                    payload: {
                      errors: {
                        $exists: false,
                      },
                    },
                  },
                ],
              },
              payload: ['errors', 'account', 'phone'],
            },
          },
        });
      }
      this.serverTrackingFilter = new ServerTrackingFilter(this.db);
      await this.serverTrackingFilter.load();
    });
    this.app.use(
      async (ctx: Context, next) => {
        await next();
        if (ctx.action) {
          const { actionName, resourceName } = ctx.action;
          if (this.serverTrackingFilter?.check(resourceName, actionName)) {
            const whiteList = this.serverTrackingFilter.whiteList;
            return await handleOtherAction(ctx, next, whiteList);
          }
        }
      },
      { tag: 'trackingConfig', before: 'errorHandler' },
    );
  }

  async load() {
    if (isMainThread) {
      this.addServerTrackingListener();
    }
    this.app.acl.allow('instrumentation', 'create', 'public');
    this.app.acl.allow('instrumentation', ['list', 'query'], 'loggedIn');
    this.app.acl.registerSnippet({
      name: `pm.system-services.custom-instrumentation.clientTracking`,
      actions: ['trackingEvents:*'],
    });
    this.app.acl.registerSnippet({
      name: `pm.system-services.custom-instrumentation.trackingConfig`,
      actions: ['trackingConfig:*'],
    });
    this.app.acl.registerSnippet({
      name: `pm.system-services.custom-instrumentation.trackingStatistics`,
      actions: ['statisticsConfig:*'],
    });
    this.app.acl.registerSnippet({
      name: `pm.system-services.custom-instrumentation.statisticsDetails`,
      actions: ['instrumentation:*'],
    });
    this.app.acl.registerSnippet({
      name: `pm.system-services.custom-instrumentation.statisticsHistorical`,
      actions: ['trackingHistoryOptions:*'],
    });
  }
}

export default ModuleInstrumentationServer;

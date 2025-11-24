import { resolve } from 'node:path';
import { InjectedPlugin, Plugin } from '@tego/server';

import { CronJobsController } from './actions/cron-jobs-controller';
import { CronJobModel } from './model/CronJobModel';
import { StaticScheduleTrigger } from './service/StaticScheduleTrigger';

@InjectedPlugin({
  Controllers: [CronJobsController],
  Services: [StaticScheduleTrigger],
})
export class PluginCronJobServer extends Plugin {
  async afterAdd() {}

  async beforeLoad() {
    this.app.db.registerModels({
      CronJobModel,
    });
  }

  async load() {
    const collectionsDir = resolve(__dirname, 'collections');
    const cronJobsCollection = this.db.getCollection('cronJobs');
    if (!cronJobsCollection) {
      await this.db.import({
        directory: collectionsDir,
        from: this.options.packageName || '@tachybase/module-cron',
      });
    }

    this.app.acl.registerSnippet({
      name: 'pm.system-services.cron',
      actions: ['cronJobs:*'],
    });
  }

  async install() {}

  async afterEnable() {}

  async afterDisable() {}

  async remove() {}
}

export default PluginCronJobServer;

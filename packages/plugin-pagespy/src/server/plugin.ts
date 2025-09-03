import { Plugin } from '@tego/server';

export class PluginPluginPagespy extends Plugin {
  async load() {
    this.app.on('afterStart', async () => {
      const PageSpyRecord = await this.app.db.getRepository('pagespy').findOne();
      if (!PageSpyRecord) {
        await this.app.db.getRepository('pagespy').create({
          values: {
            id: 1,
            api: 'localhost:6752',
            project: 'tachybase-debug',
            title: 'tachybase',
          },
        });
      }
    });
    this.app.acl.registerSnippet({
      name: `pm.system-services.pagespy-config`,
      actions: ['pagespy:*'],
    });
  }
}

export default PluginPluginPagespy;

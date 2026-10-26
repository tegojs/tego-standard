import { InstallOptions, Plugin, type PluginOptions } from '@tego/server';

import { namespace } from '..';
import { createImportXlsx, downloadXlsxTemplate, importXlsx, type ImportXlsxResolver } from './actions';
import { enUS, zhCN } from './locale';
import { importMiddleware } from './middleware';

export { createImportXlsx } from './actions';
export type { ImportXlsxExecutor, ImportXlsxResolver } from './actions';

export interface ImportPluginOptions extends PluginOptions {
  /** Server bootstrap only; selected executors own authorization, parsing, writes and the response. */
  importResolver?: ImportXlsxResolver;
}

export class ImportPlugin extends Plugin {
  declare options: ImportPluginOptions;

  beforeLoad() {
    this.app.i18n.addResources('zh-CN', namespace, zhCN);
    this.app.i18n.addResources('en-US', namespace, enUS);
  }

  async load() {
    // Capture and validate before registration; later option mutations cannot replace this entry.
    const resolve = this.options.importResolver;
    const handler = resolve === undefined ? importXlsx : createImportXlsx(resolve);
    this.app.resourcer.use(importMiddleware, { tag: 'importXlsx' });
    this.app.resourcer.registerActionHandler('downloadXlsxTemplate', downloadXlsxTemplate);
    this.app.resourcer.registerActionHandler('importXlsx', handler);

    this.app.acl.setAvailableAction('importXlsx', {
      displayName: '{{t("Import")}}',
      allowConfigureFields: true,
      type: 'new-data',
      onNewRecord: true,
    });

    this.app.acl.allow('*', 'downloadXlsxTemplate', 'loggedIn');
  }

  async install(options: InstallOptions) {
    // TODO
  }
}

export default ImportPlugin;

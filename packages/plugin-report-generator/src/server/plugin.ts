import { InjectedPlugin, Plugin } from '@tego/server';

import { ReportGeneratorController } from './actions/report-controller';
import { enUS, zhCN } from './locale';

const namespace = '@tachybase/plugin-report-generator';

@InjectedPlugin({
  Controllers: [ReportGeneratorController],
})
export class PluginReportGeneratorServer extends Plugin {
  beforeLoad() {
    this.app.i18n.addResources('zh-CN', namespace, zhCN);
    this.app.i18n.addResources('en-US', namespace, enUS);
  }

  async load() {
    this.app.acl.registerSnippet({
      name: `pm.system-services.report-generator`,
      actions: ['reportGenerator:*'],
    });
  }
}

export default PluginReportGeneratorServer;

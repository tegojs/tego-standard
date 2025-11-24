import { Plugin } from '@tachybase/client';

import { lang } from './locale';
import { ReportGeneratorProvider } from './ReportGeneratorProvider';
import { ReportGeneratorSettings } from './ReportGeneratorSettings';

export class PluginReportGeneratorClient extends Plugin {
  async load() {
    this.app.use(ReportGeneratorProvider);
    this.app.systemSettingsManager.add('system-services.report-generator', {
      icon: 'FileTextOutlined',
      title: lang('Report Generator'),
      Component: ReportGeneratorSettings,
      aclSnippet: 'pm.system-services.report-generator',
    });
  }
}

export default PluginReportGeneratorClient;

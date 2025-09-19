import { Plugin } from '@tachybase/client';

import { useMatch } from 'react-router';

import { ShareButton } from './component/ShareButton';
import { SharePage } from './component/SharePage';
import { ShareSchemaComponent } from './component/ShareSchemaComponent';
import { useEnablePageShare } from './hook/useEnableSharePage';
import { useShareVisible } from './hook/useShareVisible';
import { MEnableSharePage } from './mobile/component/MpageSharePage';
import { MShareModal } from './mobile/component/MShareModal';
import { SharePageProvider } from './provider/sharePageProvider';

export class PluginShareClient extends Plugin {
  async load() {
    this.app.addProvider(SharePageProvider);
    this.app.addComponents({
      ShareButton,
      MEnableSharePage,
      MShareModal,
    });
    this.router.add('share', {
      path: '/share',
      Component: SharePage,
    });
    this.router.add('share.page', { path: '/share/:name/:id', Component: ShareSchemaComponent });
    this.schemaSettingsManager.addItem('MPage:Dropdown', 'Menablesharepage', {
      type: 'item',
      useVisible() {
        const isShare = useMatch('/share/:name/:id');
        return !isShare;
      },
      Component: 'MEnableSharePage',
    });
    this.schemaSettingsManager.addItem('PageSettings', 'enablesharepage', {
      type: 'switch',
      useVisible() {
        const isShare = useMatch('/share/:name/:id');
        const roleShare = useShareVisible();
        return !isShare && roleShare;
      },
      useComponentProps: useEnablePageShare,
    });
  }
}

export default PluginShareClient;

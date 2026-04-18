import { Plugin } from '@tachybase/client';

import CurrentTenantProvider from './CurrentTenantProvider';
import TenantMenuProvider from './TenantMenuProvider';

class PluginTenantClient extends Plugin {
  async load() {
    this.app.use(CurrentTenantProvider);
    this.app.use(TenantMenuProvider);
  }
}

export default PluginTenantClient;

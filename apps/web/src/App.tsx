import { Application } from '@tachybase/client';

import devDynamicImport from './dynamic-import';
import { PluginWeb } from './PluginWeb';

declare global {
  interface Window {
    __tachybase_public_path__: string;
    __tachybase_api_base_url__: string;
    __tachybase_ws_url__: string;
    __tachybase_ws_path__: string;
  }
}

export const app = new Application({
  apiClient: {
    baseURL: window['__tachybase_api_base_url__'] || ctx.tego.environment.getVariables().API_BASE_URL || '/api/',
  },
  publicPath: window['__tachybase_public_path__'] || ctx.tego.environment.getVariables().APP_PUBLIC_PATH || '/',
  plugins: [PluginWeb],
  ws: {
    url: window['__tachybase_ws_url__'] || ctx.tego.environment.getVariables().WEBSOCKET_URL || '',
    basename: window['__tachybase_ws_path__'] || ctx.tego.environment.getVariables().WS_PATH || '/ws',
  },
  loadRemotePlugins: true,
  devDynamicImport: devDynamicImport as any,
});

export default app.getRootComponent();

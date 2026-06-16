// 重置浏览器样式
import 'antd/dist/reset.css';
import './global.less';
import './preload';

import { registerTachybaseClientExports } from './application/utils/clientModuleRegistry';
import * as clientExports from './exports';

registerTachybaseClientExports(clientExports);

export * from './exports';

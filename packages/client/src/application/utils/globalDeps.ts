import React from 'react';
import * as tachybaseSchema from '@tachybase/schema';

import * as antdCssinjs from '@ant-design/cssinjs';
import * as antdIcons from '@ant-design/icons';
import * as dndKitAccessibility from '@dnd-kit/accessibility';
import * as dndKitCore from '@dnd-kit/core';
import * as dndKitModifiers from '@dnd-kit/modifiers';
import * as dndKitSortable from '@dnd-kit/sortable';
import * as dndKitUtilities from '@dnd-kit/utilities';
import * as emotionCss from '@emotion/css';
import * as floatingUI from '@floating-ui/react';
import * as tegoClient from '@tego/client';
import type { RequireJS } from '@tego/client';
import * as ahooks from 'ahooks';
import * as antd from 'antd';
import * as antdStyle from 'antd-style';
import axios from 'axios';
import dayjs from 'dayjs';
import * as i18next from 'i18next';
import lodash from 'lodash';
import ReactDOM from 'react-dom';
import * as reactI18next from 'react-i18next';
import * as ReactRouter from 'react-router';
import * as ReactRouterDom from 'react-router-dom';
import jsxRuntime from 'react/jsx-runtime';

import * as tachybaseClient from '../../index';

/**
 * @internal
 */
export function defineGlobalDeps(requirejs: RequireJS) {
  // react
  requirejs.define('react', () => React);
  requirejs.define('react-dom', () => ReactDOM);
  requirejs.define('react/jsx-runtime', () => jsxRuntime);

  // react-router
  requirejs.define('react-router', () => ReactRouter);
  requirejs.define('react-router-dom', () => ReactRouterDom);

  // antd
  requirejs.define('antd', () => antd);
  requirejs.define('antd-style', () => antdStyle);
  requirejs.define('@ant-design/icons', () => antdIcons);
  requirejs.define('@ant-design/cssinjs', () => antdCssinjs);

  // i18next
  requirejs.define('i18next', () => i18next);
  requirejs.define('react-i18next', () => reactI18next);

  // tachybase
  requirejs.define('@tego/client', () => tegoClient);
  requirejs.define('@tachybase/client', () => tachybaseClient);
  requirejs.define('@tachybase/schema', () => tachybaseSchema);

  // dnd-kit 相关
  requirejs.define('@dnd-kit/accessibility', () => dndKitAccessibility);
  requirejs.define('@dnd-kit/core', () => dndKitCore);
  requirejs.define('@dnd-kit/modifiers', () => dndKitModifiers);
  requirejs.define('@dnd-kit/sortable', () => dndKitSortable);
  requirejs.define('@dnd-kit/utilities', () => dndKitUtilities);

  // utils
  requirejs.define('axios', () => axios);
  requirejs.define('dayjs', () => dayjs);
  requirejs.define('lodash', () => lodash);
  requirejs.define('ahooks', () => ahooks);
  requirejs.define('@emotion/css', () => emotionCss);
  requirejs.define('@floating-ui/react', () => floatingUI);
}

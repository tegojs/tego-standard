// 重置浏览器样式
import 'antd/dist/reset.css';
import './global.less';
import './preload';

// 重新导出核心包（向后兼容）
export * from '@tachybase/client-core';
export * from '@tachybase/client-plugins';

export * from './built-in/acl';
// api-client 已迁移到 client-core，不再导出
// export * from './api-client';
// application 已迁移到 client-core，不再导出
// export * from './application';
// async-data-provider 已迁移到 client-core，不再导出
// export * from './async-data-provider';
// block-provider 已迁移到 client-core，不再导出
// export * from './block-provider';
// collection-manager 已迁移到 client-core，不再导出
// export * from './collection-manager';

export * from './common';
export * from './style/css-variable';
// data-source 已迁移到 client-core，不再导出
// export * from './data-source';
export * from './built-in/document-title';
// filter-provider 已迁移到 client-core，不再导出
// export * from './filter-provider';
// flag-provider 已迁移到 client-core，不再导出
// export * from './flag-provider';
export * from './style/theme';
// hooks 已迁移到 client-core，不再导出
// export * from './hooks';
// i18n 已迁移到 client-core，不再导出
// export * from './i18n';
export * from './icon';
export { default as locale } from './locale';
// built-in 导出，但排除已迁移到 client-core 的 PluginManager
export * from './built-in';
export * from './built-in/pinned-list';
// built-in/pm 中的 PluginManager 与核心 PluginManager 冲突，使用别名导出
export { PluginManager as PluginManagerUI } from './built-in/pm';
export type { AllowedActions, IMetaData, TData } from './built-in/pm';
export { SettingsCenterDropdown } from './built-in/pm';
export { AdminSettingsLayout, SettingsCenterContext } from './built-in/pm';
export * from './powered-by';
export * from './record-provider';
export * from './route-switch';
export * from './schema-component';
export * from './schema-initializer';
export * from './schema-items';
export * from './schema-settings';
export * from './schema-templates';
export * from './style';
export type { CustomToken } from './style/theme';
export * from './built-in/system-settings';
export * from './testUtils';
export * from './user';
export * from './variables';

export { withDynamicSchemaProps } from './application/hoc/withDynamicSchemaProps';

export * from './modules/blocks/BlockSchemaToolbar';
export * from './modules/blocks/data-blocks/details-multi/setDataLoadingModeSettingsItem';
export * from './modules/blocks/data-blocks/form';
export * from './modules/blocks/data-blocks/table';
export * from './modules/blocks/data-blocks/table-selector';
export * from './modules/fields/component/SubTable/secondLevelSelect';
export { useTranslation } from 'react-i18next';
export * from 'react-i18next';
export { useHotkeys } from 'react-hotkeys-hook';

export * from './modules/blocks/useParentRecordCommon';

export { findSchema as findSchemaUtils, removeGridFormItem } from './schema-initializer/utils';

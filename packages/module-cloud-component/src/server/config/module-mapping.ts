/**
 * 模块映射配置
 * 将客户端模块名映射到服务端模块名
 */
export interface ModuleMapping {
  [clientModule: string]: string;
}

/**
 * 默认模块映射配置
 */
export const DEFAULT_MODULE_MAPPINGS: ModuleMapping = {
  '@tachybase/utils/client': '@tachybase/utils',
  '@tachybase/module-pdf/client': '@tachybase/module-pdf',
  '@react-pdf/renderer': '@tachybase/module-pdf',
  // 兼容旧的 hera 模块
  '@hera/plugin-core': '@tachybase/module-hera',
};

/**
 * 获取模块映射
 * 可以从环境变量、配置文件或数据库加载自定义映射
 */
export function getModuleMappings(): ModuleMapping {
  // TODO: 可以从环境变量或配置文件中加载自定义映射
  // 例如：process.env.CLOUD_COMPONENT_MODULE_MAPPINGS
  return {
    ...DEFAULT_MODULE_MAPPINGS,
  };
}

/**
 * 解析模块名（应用映射规则）
 */
export function resolveModuleName(moduleName: string, mappings: ModuleMapping): string {
  return mappings[moduleName] || moduleName;
}

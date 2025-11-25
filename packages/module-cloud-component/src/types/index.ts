/**
 * 云组件类型定义
 */

/**
 * 云组件库（开发态）
 */
export interface CloudLibrary {
  id?: number;
  name: string;
  code: string;
  data?: Record<string, any>;
  description?: string;
  enabled: boolean;
  isClient: boolean;
  isServer: boolean;
  module: string;
  serverPlugin?: string;
  clientPlugin?: string;
  component?: string;
  version: string;
  versions?: Array<{
    code: string;
    version: string;
    createdAt?: Date;
  }>;
  createdAt?: Date;
  updatedAt?: Date;
  createdBy?: number;
  updatedBy?: number;
}

/**
 * 生效的云组件库（运行态）
 */
export interface EffectLibrary {
  id?: number;
  name: string;
  module: string;
  enabled: boolean;
  server?: string; // 编译后的服务端代码
  client?: string; // 编译后的客户端代码
  isClient: boolean;
  isServer: boolean;
  serverPlugin?: string;
  clientPlugin?: string;
  component?: string;
  version?: string;
}

/**
 * 编译结果
 */
export interface CompileResult {
  code: string | null;
  error?: CompileError;
}

/**
 * 编译错误
 */
export interface CompileError {
  message: string;
  line?: number;
  column?: number;
  rawMessage?: string;
  stack?: string;
}

/**
 * 云组件模块导出
 */
export interface CloudComponentModule {
  default?: React.ComponentType<any>;
  [key: string]: any;
}

/**
 * 云组件插件导出
 */
export interface CloudComponentPlugin {
  name?: string;
  [key: string]: any;
}

/**
 * 编译缓存
 */
export interface CompileCache {
  code: string;
  result: string;
  timestamp: number;
}

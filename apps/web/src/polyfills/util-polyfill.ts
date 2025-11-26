/**
 * util 模块的完整 polyfill
 *
 * 这个文件作为 util 模块的包装器，确保包含 TextEncoder、TextDecoder 和所有其他 util 方法
 * 它会先加载 @rsbuild/plugin-node-polyfill 提供的 util polyfill，然后添加 TextEncoder 和 TextDecoder
 */

// 获取浏览器的 TextEncoder 和 TextDecoder
const BrowserTextEncoder = typeof globalThis.TextEncoder !== 'undefined' ? globalThis.TextEncoder : undefined;
const BrowserTextDecoder = typeof globalThis.TextDecoder !== 'undefined' ? globalThis.TextDecoder : undefined;

// 确保 TextEncoder 和 TextDecoder 是构造函数
if (!BrowserTextEncoder || typeof BrowserTextEncoder !== 'function') {
  throw new Error('[Polyfill] TextEncoder is not a constructor');
}

// 尝试从 @rsbuild/plugin-node-polyfill 获取基础的 util 模块
// 如果不存在，创建一个基本的 util 对象
let baseUtil: any = {};

// 在浏览器环境中，@rsbuild/plugin-node-polyfill 会通过 webpack 的 require 系统提供 util
// 我们需要创建一个包装器，确保 TextEncoder 和 TextDecoder 被正确添加

// 创建完整的 util 对象
const util = {
  // 首先尝试从基础的 util 模块获取所有方法
  ...baseUtil,

  // 添加 TextEncoder 和 TextDecoder
  TextEncoder: BrowserTextEncoder,
  TextDecoder: BrowserTextDecoder,
};

// 如果存在基础的 util 模块（由 @rsbuild/plugin-node-polyfill 提供），合并它
// 注意：在 webpack/rspack 环境中，util 模块会通过 __webpack_require__ 加载
// 我们需要在运行时动态获取它

// 使用立即执行的函数来设置
(function () {
  // 尝试获取已加载的 util 模块
  // @ts-ignore
  if (typeof __webpack_require__ !== 'undefined') {
    try {
      // @ts-ignore
      const utilModule =
        __webpack_require__.cache && __webpack_require__.cache[__webpack_require__.resolveWeak('util')];
      if (utilModule && utilModule.exports) {
        // 合并基础 util 的所有属性
        Object.assign(util, utilModule.exports);
        // 确保 TextEncoder 和 TextDecoder 存在且是构造函数
        util.TextEncoder = BrowserTextEncoder;
        util.TextDecoder = BrowserTextDecoder;
      }
    } catch (e) {
      // 忽略错误
    }
  }

  // 也尝试通过 require 获取（如果可用）
  // @ts-ignore
  if (typeof require !== 'undefined') {
    try {
      // @ts-ignore
      const baseUtilModule = require('node:util');
      if (baseUtilModule && typeof baseUtilModule === 'object') {
        // 合并所有属性
        Object.assign(util, baseUtilModule);
        // 确保 TextEncoder 和 TextDecoder 是构造函数
        util.TextEncoder = BrowserTextEncoder;
        util.TextDecoder = BrowserTextDecoder;
      }
    } catch (e) {
      // 忽略错误，util 模块可能还没有被加载
    }
  }
})();

// 导出 util 对象
export default util;

// CommonJS 导出
// @ts-ignore
if (typeof module !== 'undefined' && module.exports) {
  // @ts-ignore
  module.exports = util;
  // 确保所有属性都被导出
  Object.keys(util).forEach((key) => {
    // @ts-ignore
    module.exports[key] = util[key];
  });
}

// 导出 TextEncoder 和 TextDecoder
export const TextEncoder = BrowserTextEncoder;
export const TextDecoder = BrowserTextDecoder;

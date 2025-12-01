import { defineConfig } from '@tego/devkit';

/**
 * Desktop 应用构建配置
 *
 * 注意：此配置仅用于满足构建系统的要求，实际构建流程由以下方式处理：
 * 1. TypeScript 编译：通过 `tsc` 直接编译（见 package.json 的 build 脚本）
 * 2. 应用打包：通过 `electron-builder` 进行打包（见 electron-builder.config.js）
 *
 * 此文件提供一个虚拟入口以避免 tsup 报错 "No input files"
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  outDir: '.build-temp',
  skipBuild: true,
  dts: false,
  clean: true,
  silent: true,
});

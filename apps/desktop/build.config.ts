import { defineConfig } from '@tego/devkit';

// 跳过构建，因为 desktop 应用使用自己的构建流程（electron-builder）
// desktop 应用有自己的构建脚本：tsc + electron-builder
// 这里提供一个空的入口文件，避免 tsup 报错 "No input files"
export default defineConfig({
  entry: [],
  // 不输出任何文件
  format: [],
  // 跳过构建
  skipBuild: true,
});

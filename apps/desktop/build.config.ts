import { defineConfig } from '@tego/devkit';

// 跳过构建，因为 desktop 应用使用自己的构建流程（electron-builder）
// desktop 应用有自己的构建脚本：tsc + electron-builder
// 提供一个虚拟入口文件（src/index.ts）来避免 tsup 报错 "No input files"
export default defineConfig({
  entry: ['src/index.ts'],
  // 提供一个格式以避免 tsup 错误（即使设置了 skipBuild，某些构建系统可能仍会调用 tsup）
  format: ['cjs'],
  // 输出到临时目录（如果构建系统仍然执行构建）
  outDir: '.build-temp',
  // 跳过构建（如果构建系统支持）
  skipBuild: true,
  // 不生成类型定义文件
  dts: false,
  // 清空输出目录
  clean: true,
  // 静默模式，减少输出
  silent: true,
});

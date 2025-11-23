/**
 * 虚拟入口文件
 * 此包使用自己的构建流程（tsc + electron-builder），不需要通过 tsup 构建
 * 此文件仅用于避免 tsup 报错 "No input files"
 */

// 导出空对象，避免模块解析错误
export {};

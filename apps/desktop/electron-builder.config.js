// electron-builder 配置文件（JavaScript 版本）
// electron-builder 不支持 TypeScript 配置文件，所以需要 JavaScript 版本

const config = {
  appId: 'com.tachybase.app',
  // 明确设置产品名称，避免使用 package.json 中的 @tego/desktop
  // 这确保生成的应用名称不包含 @ 符号，避免 macOS 兼容性问题
  productName: 'Tachybase',
  // 全局设置输出文件名格式，避免使用 package.json 中的 @tego/desktop
  artifactName: '${productName}-${version}-${arch}.${ext}',
  directories: {
    output: 'dist',
    buildResources: 'build',
  },
  // 禁用原生模块重建（因为没有使用原生模块）
  buildDependenciesFromSource: false,
  npmRebuild: false,
  // 启用 asar 打包以提高性能
  asar: true,
  // 配置 asar 打包，排除 web-dist、backend 和 loading.html（需要从文件系统直接访问）
  asarUnpack: ['web-dist/**/*', 'backend/**/*', 'app/loading.html', 'app/i18n/**/*'],
  files: [
    // 包含编译后的文件（现在在 app 目录）
    'app/**/*',
    'package.json',
    // 排除不需要的文件和目录
    '!electron/**/*',
    '!node_modules/**/*',
    '!src/**/*',
    '!*.ts',
    '!*.tsx',
    '!tsconfig.json',
    '!electron-builder.config.ts',
    '!electron-builder.config.js',
    '!README.md',
    '!DESKTOP_APP_GUIDE.md',
    '!scripts/**/*',
    '!build/**/*',
    '!dist/**/*', // 排除 dist 目录（web 构建产物）
    '!web-dist-temp/**/*', // 排除临时目录
    '!backend-temp/**/*', // 排除临时目录
  ],
  // 明确指定 main 文件路径（相对于打包后的应用根目录）
  extraMetadata: {
    main: 'app/main.js',
  },
  // 使用 extraResources 直接从源目录包含资源文件
  // electron-builder 会自动处理文件复制，无需手动创建临时目录
  // 注意：extraResources 中的路径是相对于配置文件所在目录的
  extraResources: [
    {
      from: '../web/dist',
      to: 'web-dist',
      filter: ['**/*'],
    },
    {
      from: 'backend-temp',
      to: 'backend',
      filter: ['**/*'],
    },
  ],
  mac: {
    category: 'public.app-category.productivity',
    target: [
      {
        target: 'dmg',
        arch: ['arm64'], // 只构建当前架构，避免 zip 构建错误
      },
    ],
    icon: 'build/icon.icns',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    // 使用 extendInfo 明确设置 Info.plist 中的值，避免使用 package.json 中的 @tego/desktop
    extendInfo: {
      // 设置应用显示名称
      CFBundleDisplayName: 'Tachybase',
      // 设置应用名称（不包含 @ 符号）
      CFBundleName: 'Tachybase',
      // 设置可执行文件名称（不包含 @ 符号）
      CFBundleExecutable: 'Tachybase',
      // 确保 Bundle ID 正确
      CFBundleIdentifier: 'com.tachybase.app',
    },
    // artifactName 已在全局配置中设置，使用全局配置即可
  },
  dmg: {
    // 标准 DMG 拖动安装配置
    // 包含应用文件和 Applications 文件夹链接
    // 注意：顺序很重要，Applications 链接通常在右侧，应用文件在左侧
    contents: [
      {
        x: 130,
        y: 220,
        type: 'file', // 应用文件（左侧）
      },
      {
        x: 410,
        y: 220,
        type: 'link', // Applications 文件夹链接（右侧）
        path: '/Applications',
      },
    ],
    // 窗口大小和位置
    window: {
      width: 540,
      height: 400,
    },
    // 图标大小（可选）
    iconSize: 128,
    // 背景颜色（可选，也可以使用背景图片）
    backgroundColor: '#ffffff',
    // 确保 DMG 格式正确
    format: 'UDZO', // 压缩格式，标准 DMG 格式
  },
  win: {
    target: ['nsis'],
    icon: 'build/icon.ico',
  },
  linux: {
    target: ['AppImage', 'deb'],
    category: 'Office',
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
  },
  // 注意：
  // - web-dist 通过 extraResources 直接从 ../web/dist 包含（无需临时目录）
  // - backend 通过 extraResources 从 backend-temp 包含（由 prepare-backend.js 执行 pnpm install --prod 准备）
  // - node 可执行文件由 copy-node-executable.js 在打包后复制
  // - DMG 创建由 create-dmg.js 在打包后执行
};

module.exports = config;

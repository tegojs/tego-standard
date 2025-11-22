import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { AfterPackContext, Configuration } from 'electron-builder';

const config: Configuration = {
  appId: 'com.tachybase.app',
  // 明确设置产品名称，避免使用 package.json 中的 @tego/desktop
  // 这确保生成的应用名称不包含 @ 符号，避免 macOS 兼容性问题
  productName: 'Tachybase',
  directories: {
    output: 'dist',
    buildResources: 'build',
  },
  // 禁用原生模块重建（因为没有使用原生模块）
  buildDependenciesFromSource: false,
  npmRebuild: false,
  // 启用 asar 打包以提高性能
  asar: true,
  // 配置 asar 打包，排除 web-dist（需要从文件系统直接访问）
  asarUnpack: ['web-dist/**/*'],
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
    '!README.md',
    '!DESKTOP_APP_GUIDE.md',
    '!scripts/**/*',
    '!build/**/*',
    '!dist/**/*', // 排除 dist 目录（web 构建产物）
    '!web-dist-temp/**/*', // 排除临时目录
  ],
  // 明确指定 main 文件路径（相对于打包后的应用根目录）
  extraMetadata: {
    main: 'app/main.js',
  },
  // 使用 extraFiles 将临时目录复制到 Resources/web-dist
  // 临时目录由 prepare-web-dist.js 脚本在打包前创建
  extraFiles: [
    {
      from: path.resolve(__dirname, 'web-dist-temp'),
      to: 'web-dist',
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
    // 确保应用名称正确（不包含 @ 符号）
    artifactName: '${productName}-${version}-${arch}.${ext}',
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
  // 在打包后自动复制 web-dist
  afterPack: async (context: AfterPackContext) => {
    console.log('[afterPack] Hook started');
    const { appOutDir, packager } = context;
    const platformName = packager.platform.name;
    console.log(`[afterPack] Platform: ${platformName}, appOutDir: ${appOutDir}`);

    // 只在 macOS 上执行
    if (platformName === 'darwin') {
      // 尝试多个可能的源路径
      // __dirname 是 electron-builder.config.ts 所在的目录（apps/desktop）
      const configDir = __dirname;
      const possibleSources = [
        path.resolve(configDir, '../web/dist'), // apps/web/dist
        path.resolve(configDir, 'web-dist-temp'), // apps/desktop/web-dist-temp
      ];

      console.log(`[afterPack] Config directory: ${configDir}`);
      console.log(`[afterPack] Checking possible sources: ${possibleSources.join(', ')}`);

      let webDistSrc: string | null = null;
      for (const src of possibleSources) {
        const exists = fs.existsSync(src);
        const hasIndex = exists && fs.existsSync(path.join(src, 'index.html'));
        console.log(`[afterPack] Checking ${src}: exists=${exists}, hasIndex=${hasIndex}`);
        if (exists && hasIndex) {
          webDistSrc = src;
          console.log(`[afterPack] ✓ Found web-dist source at: ${webDistSrc}`);
          break;
        }
      }

      if (!webDistSrc) {
        console.error(`[afterPack] ✗ Web dist source not found in any of: ${possibleSources.join(', ')}`);
        // 列出所有可能的路径供调试
        possibleSources.forEach((src) => {
          const exists = fs.existsSync(src);
          console.error(`[afterPack]   - ${src}: ${exists ? 'exists' : 'NOT FOUND'}`);
          if (exists) {
            try {
              const contents = fs.readdirSync(src);
              console.error(`[afterPack]     Contents: ${contents.slice(0, 5).join(', ')}...`);
            } catch (e) {
              console.error(`[afterPack]     Cannot read directory: ${e}`);
            }
          }
        });
        return;
      }

      // 查找 .app 文件（appOutDir 可能直接是 .app 目录，或者包含 .app 目录）
      let appBundlePath: string;
      if (appOutDir.endsWith('.app')) {
        appBundlePath = appOutDir;
        console.log(`[afterPack] appOutDir is .app: ${appBundlePath}`);
      } else {
        // 在 appOutDir 中查找 .app 文件
        console.log(`[afterPack] Searching for .app in: ${appOutDir}`);
        const files = fs.readdirSync(appOutDir);
        console.log(`[afterPack] Files in appOutDir: ${files.join(', ')}`);
        const appFile = files.find((f) => f.endsWith('.app'));
        if (!appFile) {
          console.error(`[afterPack] ✗ .app file not found in ${appOutDir}`);
          console.error(`[afterPack] Available files: ${files.join(', ')}`);
          return;
        }
        appBundlePath = path.join(appOutDir, appFile);
        console.log(`[afterPack] Found .app: ${appBundlePath}`);
      }

      const resourcesDir = path.join(appBundlePath, 'Contents', 'Resources');
      const webDistDest = path.join(resourcesDir, 'web-dist');

      console.log('[afterPack] Copying web-dist to app bundle...');
      console.log(`[afterPack] Source: ${webDistSrc}`);
      console.log(`[afterPack] Destination: ${webDistDest}`);
      console.log(`[afterPack] App bundle: ${appBundlePath}`);
      console.log(`[afterPack] Resources dir: ${resourcesDir}`);

      if (!fs.existsSync(resourcesDir)) {
        console.error(`[afterPack] ✗ Resources directory not found at ${resourcesDir}`);
        // 列出 appBundlePath 的内容
        if (fs.existsSync(appBundlePath)) {
          try {
            const contents = fs.readdirSync(appBundlePath);
            console.error(`[afterPack] Contents of app bundle: ${contents.join(', ')}`);
          } catch (e) {
            console.error(`[afterPack] Cannot read app bundle: ${e}`);
          }
        }
        return;
      }

      // 删除已存在的 web-dist
      if (fs.existsSync(webDistDest)) {
        console.log(`[afterPack] Removing existing web-dist directory`);
        fs.rmSync(webDistDest, { recursive: true, force: true });
      }

      // 复制 web-dist
      try {
        console.log(`[afterPack] Executing: cp -R "${webDistSrc}" "${webDistDest}"`);
        execSync(`cp -R "${webDistSrc}" "${webDistDest}"`, { stdio: 'inherit' });

        // 验证复制结果
        const indexHtmlPath = path.join(webDistDest, 'index.html');
        console.log(`[afterPack] Verifying copy result...`);
        console.log(`[afterPack] webDistDest exists: ${fs.existsSync(webDistDest)}`);
        console.log(`[afterPack] index.html exists: ${fs.existsSync(indexHtmlPath)}`);

        if (fs.existsSync(webDistDest) && fs.existsSync(indexHtmlPath)) {
          console.log(`[afterPack] ✓ Web dist copied successfully`);
          console.log(`[afterPack] ✓ index.html found at ${indexHtmlPath}`);
        } else {
          console.error(`[afterPack] ✗ Failed to copy web-dist or index.html not found`);
          // 列出目标目录的内容
          if (fs.existsSync(resourcesDir)) {
            try {
              const contents = fs.readdirSync(resourcesDir);
              console.error(`[afterPack] Contents of Resources directory: ${contents.join(', ')}`);
            } catch (e) {
              console.error(`[afterPack] Cannot read Resources directory: ${e}`);
            }
          }
        }
      } catch (error: any) {
        console.error(`[afterPack] ✗ Error copying web-dist: ${error.message}`);
        console.error(`[afterPack] Error stack: ${error.stack}`);
      }
    } else {
      console.log(`[afterPack] Skipping (not macOS)`);
    }
    console.log('[afterPack] Hook completed');
  },
};

export default config;

// @ts-ignore - Node.js built-in modules
import * as path from 'node:path';
// @ts-ignore - Node.js built-in modules
import { fileURLToPath } from 'node:url';
// @ts-ignore - @tego/devkit may not have type definitions
// Import from the actual package path to avoid catalog resolution issues during build
import { getUmiConfig, IndexGenerator } from '@tachybase/plugin-devkit/src/server/utils';

import { defineConfig, type RsbuildConfig } from '@rsbuild/core';
import { pluginLess } from '@rsbuild/plugin-less';
import { pluginNodePolyfill } from '@rsbuild/plugin-node-polyfill';
import { pluginReact } from '@rsbuild/plugin-react';

// 获取当前文件的目录路径（ES 模块中替代 __dirname）
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 确保使用项目根目录，而不是当前工作目录
// 从 rsbuild.config.ts 的位置（apps/web）向上查找项目根目录
function detectProjectRoot() {
  let dir = __dirname; // apps/web
  const { parse, dirname } = path;
  const { existsSync } = require('node:fs');
  const filesystemRoot = parse(dir).root;

  while (dir && dir !== filesystemRoot) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    dir = dirname(dir);
  }

  // 如果没找到，从 apps/web 向上两级应该是项目根目录
  return path.resolve(__dirname, '../..');
}

const projectRoot = detectProjectRoot();
const config = getUmiConfig();
const pluginDirs = ['packages'].map((item) => path.join(projectRoot, item));

const outputPluginPath = path.join(__dirname, 'src/.plugins');
const indexGenerator = new IndexGenerator(outputPluginPath, pluginDirs);
indexGenerator.generate();

const rsDefined: Record<string, string> = {};
const configDefine = config.define as Record<string, unknown>;
for (const key in configDefine) {
  rsDefined[key] = JSON.stringify(configDefine[key]);
}

const rsbuildConfig: RsbuildConfig = defineConfig({
  html: {
    title: 'Tachybase',
    inject: 'body',
    template: 'src/assets/index.html',
    meta: [{ viewport: 'initial-scale=0.1' }],
    favicon: 'src/assets/favicon.ico',
    appIcon: {
      name: 'Tachybase',
      icons: [
        {
          src: 'src/assets/apple-touch-icon.png',
          size: 180,
          target: 'apple-touch-icon',
        },
        {
          src: 'src/assets/android-chrome-192x192.png',
          size: 192,
          target: 'web-app-manifest',
        },
        {
          src: 'src/assets/android-chrome-512x512.png',
          size: 512,
          target: 'web-app-manifest',
        },
      ],
    },
  },
  source: {
    define: {
      ...rsDefined,
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV),
      'process.env.REACT_APP_CLICK_TO_COMPONENT_EDITOR': JSON.stringify(
        process.env.REACT_APP_CLICK_TO_COMPONENT_EDITOR,
      ),
    },
    include: [path.join(projectRoot, 'packages')],
  },
  dev: {
    hmr: false,
    writeToDisk: false,
  },
  output: {
    distPath: {
      js: 'assets',
      css: 'assets',
      image: 'assets',
      svg: 'assets',
      font: 'assets',
      media: 'assets',
    },
    minify: true,
    overrideBrowserslist: ['chrome >= 69', 'edge >= 79', 'safari >= 12'],
  },
  server: {
    port: Number(process.env.PORT || 3000),
    open: !process.env.NO_OPEN,
    proxy: {
      ...config.proxy,
    },
  },
  plugins: [pluginReact(), pluginLess(), pluginNodePolyfill()],
  resolve: {
    alias: {
      ...Object.fromEntries(
        Object.entries(config.alias).map(([key, value]) => {
          if (typeof value === 'string') {
            let absolutePath = path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
            if (absolutePath.includes('/apps/web/')) {
              absolutePath = absolutePath.replace('/apps/web/', '/');
            }
            return [key, absolutePath];
          }
          return [key, value];
        }),
      ),
      i18next: path.join(__dirname, 'src/polyfills/i18next-keyFromSelector.ts'),
      'react-i18next': require.resolve('react-i18next') as string,
      '@swc/helpers/_/_tagged_template_literal': require.resolve(
        '@swc/helpers/esm/_tagged_template_literal.js',
      ) as string,
      '@swc/helpers/_/_define_property': require.resolve('@swc/helpers/esm/_define_property.js') as string,
      util: path.join(__dirname, 'src/polyfills/util-polyfill.ts'),
    },
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
  },
  tools: {
    rspack: (rspackConfig: any) => {
      if (!rspackConfig.module) {
        rspackConfig.module = {};
      }
      if (!rspackConfig.module.parser) {
        rspackConfig.module.parser = {};
      }
      if (!rspackConfig.module.parser.javascript) {
        rspackConfig.module.parser.javascript = {};
      }
      rspackConfig.module.parser.javascript.reexportExportsPresence = false;
      rspackConfig.module.parser.javascript.exportsPresence = false;

      if (!rspackConfig.optimization) {
        rspackConfig.optimization = {};
      }
      if (!rspackConfig.optimization.moduleIds) {
        rspackConfig.optimization.moduleIds = 'deterministic';
      }
      rspackConfig.optimization.moduleConcatenation = false;

      if (!rspackConfig.resolve) {
        rspackConfig.resolve = {};
      }
      if (!rspackConfig.resolve.byDependency) {
        rspackConfig.resolve.byDependency = {};
      }
      if (!rspackConfig.resolve.byDependency.esm) {
        rspackConfig.resolve.byDependency.esm = {};
      }
      rspackConfig.resolve.byDependency.esm.exportsPresence = false;

      rspackConfig.resolve.fallback = {
        ...rspackConfig.resolve.fallback,
        worker_threads: false,
        http2: false,
      };
      if (!rspackConfig.resolve.modules) {
        rspackConfig.resolve.modules = [];
      }
      const packagesPath = path.join(projectRoot, 'packages');
      if (!rspackConfig.resolve.modules.includes(packagesPath)) {
        rspackConfig.resolve.modules.unshift(packagesPath);
      }
      const nodeModulesPath = path.join(projectRoot, 'node_modules');
      if (!rspackConfig.resolve.modules.includes(nodeModulesPath)) {
        rspackConfig.resolve.modules.push(nodeModulesPath);
      }
      if (!rspackConfig.resolve.modules.includes('node_modules')) {
        rspackConfig.resolve.modules.push('node_modules');
      }

      // Add special alias for polyfill to import original i18next without circular dependency
      if (!rspackConfig.resolve.alias) {
        rspackConfig.resolve.alias = {};
      }
      // Use a special name that the polyfill can use to import the original module
      rspackConfig.resolve.alias['i18next-original'] = require.resolve('i18next');

      return rspackConfig;
    },
  },
});

export default rsbuildConfig;

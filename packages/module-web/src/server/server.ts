import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Application, Context, Plugin } from '@tego/server';

import { getAntdLocale } from './antd';
import { getCronLocale } from './cron';
import { getCronstrueLocale } from './cronstrue';

async function getLang(ctx: Context) {
  const SystemSetting = ctx.db.getRepository('systemSettings');
  const systemSetting = await SystemSetting.findOne();
  const enabledLanguages: string[] = systemSetting.get('enabledLanguages') || [];
  const currentUser = ctx.state.currentUser;
  let lang = enabledLanguages?.[0] || ctx.tego.environment.getVariables().APP_LANG || 'en-US';
  if (enabledLanguages.includes(currentUser?.appLang)) {
    lang = currentUser?.appLang;
  }
  if (ctx.request.query.locale && enabledLanguages.includes(ctx.request.query.locale as string)) {
    lang = ctx.request.query.locale as string;
  }
  return lang;
}

function readAppVersionFromPackageJson(): string {
  try {
    // 优先读取 .version.json 文件（构建时生成，不污染 git 状态）
    const versionJsonCandidates = [
      join(process.cwd(), '.version.json'),
      // fallback: relative to compiled file location
      join(__dirname, '../../../../.version.json'),
      join(__dirname, '../../../.version.json'),
    ];
    for (const versionPath of versionJsonCandidates) {
      if (existsSync(versionPath)) {
        const versionInfo = JSON.parse(readFileSync(versionPath, 'utf-8'));
        if (versionInfo?.version) {
          return versionInfo.version as string;
        }
      }
    }

    // 如果 .version.json 不存在，回退到读取 package.json
    const packageJsonCandidates = [
      join(process.cwd(), 'package.json'),
      // fallback: relative to compiled file location
      join(__dirname, '../../../../package.json'),
      join(__dirname, '../../../package.json'),
    ];
    for (const pkgPath of packageJsonCandidates) {
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        if (pkg?.version) {
          return pkg.version as string;
        }
      }
    }
  } catch (e) {}
  return 'Unknown';
}

export class ModuleWeb extends Plugin {
  async beforeLoad() {}

  async install() {
    const uiSchemas = this.db.getRepository<any>('uiSchemas');
    await uiSchemas.insert({
      type: 'void',
      'x-uid': 'default-admin-menu',
      'x-designer': 'Menu.Designer',
      'x-initializer': 'menuInitializers:menuItem',
      'x-component': 'Menu',
      'x-component-props': {
        mode: 'mix',
        theme: 'dark',
        onSelect: '{{ onSelect }}',
        sideMenuRefScopeKey: 'sideMenuRef',
      },
      properties: {},
    });

    await uiSchemas.insert({
      type: 'void',
      'x-uid': 'default-admin-mobile',
      'x-component': 'MContainer',
      'x-designer': 'MContainer.Designer',
      'x-component-props': {},
      properties: {
        page: {
          type: 'void',
          'x-component': 'MPage',
          'x-designer': 'MPage.Designer',
          'x-component-props': {},
          properties: {
            grid: {
              type: 'void',
              'x-component': 'Grid',
              'x-initializer': 'mobilePage:addBlock',
              'x-component-props': {
                showDivider: false,
              },
            },
          },
        },
      },
    });
  }

  async load() {
    this.app.localeManager.setLocaleFn('antd', async (lang) => getAntdLocale(lang));
    this.app.localeManager.setLocaleFn('cronstrue', async (lang) => getCronstrueLocale(lang));
    this.app.localeManager.setLocaleFn('cron', async (lang) => getCronLocale(lang));
    this.app.acl.allow('app', 'getLang');
    this.app.acl.allow('app', 'getInfo');
    this.app.acl.registerSnippet({
      name: 'app',
      actions: ['app:restart', 'app:refresh', 'app:clearCache'],
    });
    const dialect = this.app.db.sequelize.getDialect();
    const appVersion = readAppVersionFromPackageJson();

    this.app.resourcer.define({
      name: 'app',
      actions: {
        async getInfo(ctx, next) {
          const SystemSetting = ctx.db.getRepository('systemSettings');
          const systemSetting = await SystemSetting.findOne();
          const enabledLanguages: string[] = systemSetting.get('enabledLanguages') || [];
          const currentUser = ctx.state.currentUser;
          let lang = enabledLanguages?.[0] || ctx.tego.environment.getVariables().APP_LANG || 'en-US';
          if (enabledLanguages.includes(currentUser?.appLang)) {
            lang = currentUser?.appLang;
          }
          ctx.body = {
            database: {
              dialect,
            },
            version: {
              core: await ctx.tego.version.get(),
              app: appVersion,
            },
            lang,
            name: ctx.tego.name,
            theme: currentUser?.systemSettings?.theme || systemSetting?.options?.theme || 'default',
          };
          await next();
        },
        async getLang(ctx: Context, next) {
          const lang = await getLang(ctx);
          const app = ctx.tego as Application;
          const eTag = await app.localeManager.getETag(lang);
          const resources = await app.localeManager.get(lang);
          // UUID 前36位
          const requestETag = ctx.get('If-None-Match');
          if (eTag && eTag === requestETag.substring(0 + 2, 36 + 2)) {
            ctx.status = 304;
            ctx.res.setHeader('ETag', requestETag);
          } else {
            const newTag = `W/${eTag}-${requestETag.substring(36 + 1 + 2)}`;
            ctx.res.setHeader('ETag', newTag);
          }
          // TODO: 因为有下一个本地化插件,所以这里依然考虑要装载,不直接返回304
          ctx.body = {
            lang,
            ...resources,
          };
          await next();
        },
        async clearCache(ctx, next) {
          await ctx.cache.reset();
          await next();
        },
        async restart(ctx, next) {
          ctx.tego.runAsCLI(['restart'], { from: 'user' });
          await next();
        },
        async refresh(ctx, next) {
          ctx.tego.runCommand('refresh');
          await next();
        },
      },
    });
  }
}

export default ModuleWeb;

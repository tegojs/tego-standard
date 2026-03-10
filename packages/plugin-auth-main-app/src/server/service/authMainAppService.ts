import { Application, Context, Database, Next } from '@tego/server';

import { COLLECTION_AUTH_MAIN_APP_CONFIG, NAMESPACE } from '../../constants';

/**
 * 主应用登录配置管理器
 *
 * 注意: 不使用 @Service() + @App() 装饰器, 因为全局 DI Container 在多子应用并发启动时
 * 存在竞态条件, 会导致 @App() 注入错误的 Application 实例.
 * 改为由 Plugin 传入正确的 app/db 引用.
 */
export class AuthMainAppService {
  private db: Database;
  private app: Application;
  private selfSignIn: boolean = true;
  private authMainApp: boolean = true;

  constructor(app: Application) {
    this.app = app;
    this.db = app.db;
  }

  async load() {
    this.addMiddleWare();

    this.app.on('afterStart', async () => {
      await this.checkInstall();
      const config = await this.db.getRepository(COLLECTION_AUTH_MAIN_APP_CONFIG).findOne();
      if (config) {
        this.selfSignIn = config.selfSignIn ?? true;
        this.authMainApp = config.authMainApp ?? true;
      }
    });

    this.db.on(`${COLLECTION_AUTH_MAIN_APP_CONFIG}.afterSave`, (model) => {
      this.selfSignIn = model.get('selfSignIn');
      this.authMainApp = model.get('authMainApp');
    });
  }

  async checkInstall() {
    const repo = this.db.getRepository(COLLECTION_AUTH_MAIN_APP_CONFIG);
    const existOne = await repo.findOne();
    if (!existOne) {
      await repo.create({
        values: {
          selfSignIn: true,
          authMainApp: true,
        },
      });
    }
  }

  addMiddleWare() {
    this.app.resourcer.use(
      async (ctx: Context, next: Next) => {
        if (ctx.tego.name === 'main') {
          return next();
        }
        const { resourceName, actionName } = ctx.action.params;
        await next();
        if (resourceName === 'authenticators' && actionName === 'publicList') {
          if (!this.selfSignIn && !this.authMainApp) {
            return;
          }
          if (!this.selfSignIn) {
            ctx.body = [];
          }
          if (this.authMainApp) {
            // 幂等性检查: 即使中间件因某种原因执行多次, 也只添加一个主应用登录入口
            const alreadyHasMainApp =
              Array.isArray(ctx.body) && ctx.body.some((item: any) => item.authType === 'mainApp');
            if (!alreadyHasMainApp) {
              ctx.body.unshift({
                name: ctx.t('Main app signIn', { ns: NAMESPACE }),
                authType: 'mainApp',
                authTypeTitle: 'main app',
              });
            }
          }
        }
      },
      {
        tag: 'forbidSignIn',
        after: 'acl',
        unique: true,
      },
    );
  }
}

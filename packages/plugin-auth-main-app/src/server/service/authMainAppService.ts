import { App, Application, Context, Database, Db, InjectLog, Logger, Next, Service } from '@tego/server';

import { COLLECTION_AUTH_MAIN_APP_CONFIG, NAMESPACE } from '../../constants';

@Service()
export class AuthMainAppService {
  @Db()
  db: Database;

  @App()
  app: Application;

  @InjectLog()
  private logger: Logger;

  private selfSignIn: boolean = true; //子应用本身登录

  private authMainApp: boolean = true; //通过主应用登录

  async load() {
    this.addMiddleWare();

    this.app.on('afterStart', async () => {
      await this.checkInstall();
      const collection = this.db.getCollection(COLLECTION_AUTH_MAIN_APP_CONFIG);
      if (!collection) {
        this.logger.warn(`Collection ${COLLECTION_AUTH_MAIN_APP_CONFIG} is not defined`);
        return;
      }

      const repository = collection.repository;
      if (!repository) {
        this.logger.warn(`Repository for ${COLLECTION_AUTH_MAIN_APP_CONFIG} is not available`);
        return;
      }

      const config = await repository.findOne();
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
    const collection = this.db.getCollection(COLLECTION_AUTH_MAIN_APP_CONFIG);
    if (!collection) {
      this.logger.warn(`Collection ${COLLECTION_AUTH_MAIN_APP_CONFIG} is not defined`);
      return;
    }

    const repo = collection.repository;
    if (!repo) {
      this.logger.warn(`Repository for ${COLLECTION_AUTH_MAIN_APP_CONFIG} is not available`);
      return;
    }

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
            ctx.body.unshift({
              name: ctx.t('Main app signIn', { ns: NAMESPACE }),
              authType: 'mainApp',
              authTypeTitle: 'main app',
            });
          }
        }
      },
      {
        tag: 'forbidSignIn',
        after: 'acl',
      },
    );
  }
}

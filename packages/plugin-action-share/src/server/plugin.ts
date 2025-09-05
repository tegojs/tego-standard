import { ACL, BaseAuth, Context, InjectedPlugin, Plugin } from '@tego/server';

import { verifyInAction } from './actions/share';
import * as actions from './actions/users';
import { banGuestActionMiddleware } from './middlewares/ban-guest-action';

export class PluginShareServer extends Plugin {
  async beforeLoad() {
    for (const [key, action] of Object.entries(actions)) {
      this.app.resourcer.registerActionHandler(`users:${key}`, action);
    }

    const banGuestAction = banGuestActionMiddleware();

    this.app.use(
      async (ctx: Context, next) => {
        try {
          await banGuestAction(ctx, next);
        } catch (error) {
          ctx.logger.error(error);
        }
      },
      { after: 'dataSource', group: 'after' },
    );

    this.app.acl.addFixedParams('users', 'destroy', () => {
      return {
        filter: {
          'specialRole.$ne': 'guest',
        },
      };
    });
    const aclRoles = this.app.acl.snippetManager.snippets.get('pm.acl.roles');
    this.app.acl.registerSnippet({
      name: 'pm.acl.roles',
      actions: [...aclRoles.actions, 'roles.menuShareUiSchemas:*'],
    });
  }

  async load() {
    BaseAuth.prototype.check = async function () {
      let token = this.ctx.getBearerToken();
      if (!token) {
        // 注入访客用户 token, TODO: 也许有更好的方法来拦截 BaseAuth 的逻辑
        // TODO: 访客模式启用判断, 访客 token 有效期设置， 带指定参数才可访客登录，前端导航栏头像适配访客
        const user = await this.userRepository.findOne({
          filter: {
            username: 'guest',
          },
          raw: true,
        });
        if (!user) {
          this.ctx.logger.error('guest mode enabled, but no guest user in database', { method: 'check' });
          return null;
        }
        token = this.jwt.sign({
          userId: user.id,
        });
      }
      try {
        const { userId, roleName } = await this.jwt.decode(token);

        if (roleName) {
          this.ctx.headers['x-role'] = roleName;
        }

        const cache = this.ctx.cache;
        return await cache.wrap(this.getCacheKey(userId), () =>
          this.userRepository.findOne({
            filter: {
              id: userId,
            },
            raw: true,
          }),
        );
      } catch (err) {
        this.ctx.logger.error(err, { method: 'check' });
        return null;
      }
    };
    this.app.acl.allow('sharePageConfig', '*', 'public');

    this.app.resourcer.registerActionHandler('sharePageConfig:verifyIn', verifyInAction);

    this.app.use(async (ctx: Context, next) => {
      if (ctx.action?.resourceName === 'roles' && ctx.action?.actionName === 'check') {
        const url = new URL(ctx.headers.referer);
        if (url.pathname.split('/').filter(Boolean)?.[0] === 'share') {
          const lastSegment = url.pathname.split('/').pop();
          const shareConfig = await ctx.db.getRepository('sharePageConfig').findOne({ filter: { id: lastSegment } });
          if (shareConfig.permission === 'edit') {
            ctx.body.strategy.actions = ['create', 'view', 'update', 'destroy'];
          }
        }
      }
    });
  }

  getInstallingData(options: any = {}) {
    const {
      guestEmail = 'guest@tachybase.com',
      guestPassword = 'N0_PAS5W0RD',
      guestNickname = 'Guest',
      guestUsername = 'guest',
    } = options.users || options?.cliArgs?.[0] || {};
    return { guestEmail, guestPassword, guestNickname, guestUsername };
  }

  async install(options) {
    const { guestNickname, guestPassword, guestEmail, guestUsername } = this.getInstallingData(options);
    const User = this.db.getCollection('users');
    if (await User.repository.findOne({ filter: { email: guestEmail } })) {
      return;
    }

    await User.repository.create({
      values: {
        email: guestEmail,
        password: guestPassword,
        nickname: guestNickname,
        username: guestUsername,
        specialRole: 'guest',
      },
    });

    const roles = this.db.getCollection('roles');
    await roles.repository.createMany({
      records: [
        {
          name: 'guest',
          title: '{{t("Guest")}}',
          allowConfigure: false,
          allowNewMenu: false,
          snippets: ['!ui.*', '!pm', '!pm.*'],
          strategy: { actions: ['view'] },
        },
      ],
    });

    await User.repository.update({
      filter: {
        username: 'guest',
      },
      values: {
        roles: ['guest'],
      },
      forceUpdate: true,
    });
  }
}

export default PluginShareServer;

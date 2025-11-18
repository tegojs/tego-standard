import { Application, Context, Next } from '@tego/server';

import { AUTH_TIMEOUT_MINUTE, weChatApiOauthScope } from '../../constants';

export const getAuthCfg = async (ctx: Context, next: Next) => {
  const { redirect, bind } = ctx.action.params.values;
  if (bind) {
    const { authenticator } = ctx.action.params.values;
    const app = ctx.tego as Application;
    const options = await app.authManager.getOptions(authenticator);
    ctx.body = getBindAuthCfg(ctx, redirect, options?.wechatAuth?.AppID);
  } else {
    ctx.body = await ctx.auth.getAuthCfg(redirect, bind);
  }
  await next();
};

const getBindAuthCfg = (ctx, redirect: string, appID: string) => {
  const userId = ctx.auth?.user?.id;
  if (!userId) {
    ctx.throw(400, 'Bind user failed: no user found');
  }
  const app = ctx.tego.name;
  const referer = ctx.req.headers['referer'];
  let redirectUrl;
  if (referer) {
    const clientUrl = new URL(referer);
    redirectUrl = `${clientUrl.protocol}//${clientUrl.host}${ctx.tego.environment.getVariables().API_BASE_PATH}wechatAuth:redirect`;
  } else {
    redirectUrl = `${ctx.protocol}://${ctx.host}${ctx.tego.environment.getVariables().API_BASE_PATH}wechatAuth:redirect`;
  }
  let state = `redirect=${redirect}&app=${app}&name=${ctx.headers['x-authenticator']}`;

  const token = ctx.tego.authManager.jwt.sign({ userId: ctx.auth.user.id }, { expiresIn: `${AUTH_TIMEOUT_MINUTE}m` });
  state += `&bindToken=${token}`;
  return {
    appId: appID,
    scope: weChatApiOauthScope,
    redirectUrl: encodeURIComponent(redirectUrl),
    state: encodeURIComponent(encodeURIComponent(state)),
  };
};

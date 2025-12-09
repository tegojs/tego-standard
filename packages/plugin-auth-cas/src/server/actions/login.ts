import { Context, Next } from '@tego/server';

import { CASAuth } from '../auth';

export const login = async (ctx: Context, next: Next) => {
  const { authenticator, redirect = '/admin' } = ctx.action.params;
  const auth = (await ctx.tego.authManager.get(authenticator, ctx)) as CASAuth;
  const { casUrl } = auth.getOptions();
  const service = auth.getService(authenticator, ctx.tego.name, redirect);
  ctx.redirect(`${casUrl}/login?service=${service}`);
  next();
};

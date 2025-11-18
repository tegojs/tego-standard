import { AppSupervisor, Context, Next } from '@tego/server';

import { CASAuth } from '../auth';

export const service = async (ctx: Context, next: Next) => {
  const { authenticator, __appName: appName, redirect } = ctx.action.params;

  let prefix = ctx.tego.environment.getVariables().APP_PUBLIC_PATH || '';
  if (appName && appName !== 'main') {
    const appSupervisor = AppSupervisor.getInstance();
    if (appSupervisor?.runningMode !== 'single') {
      prefix += `apps/${appName}`;
    }
  }

  const auth = (await ctx.tego.authManager.get(authenticator, ctx)) as CASAuth;

  if (prefix.endsWith('/')) {
    prefix = prefix.slice(0, -1);
  }

  try {
    const { token } = await auth.signIn();
    ctx.redirect(`${prefix}${redirect || '/admin'}?authenticator=${authenticator}&token=${token}`);
  } catch (error) {
    ctx.redirect(`${prefix}/signin?authenticator=${authenticator}&error=${error.message}&redirect=${redirect}`);
  }
  return next();
};

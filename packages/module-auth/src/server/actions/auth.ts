import { Context, Next } from '@tachybase/actions';

export default {
  lostPassword: async (ctx: Context, next: Next) => {
    ctx.body = await ctx.auth.lostPassword();
    await next();
  },
  resetPassword: async (ctx: Context, next: Next) => {
    ctx.body = await ctx.auth.resetPassword();
    await next();
  },
  getUserByResetToken: async (ctx: Context, next: Next) => {
    ctx.body = await ctx.auth.getUserByResetToken();
    await next();
  },
  changePassword: async (ctx: Context, next: Next) => {
    if (ctx.action.params?.values?.verifyMethod === 'code') {
      const auth = await ctx.app.authManager.get('sms', ctx);
      ctx.body = await auth.changePassword();
    } else {
      const auth = await ctx.app.authManager.get('Email/Password', ctx);
      ctx.body = await auth.changePassword();
    }
    await next();
  },
};

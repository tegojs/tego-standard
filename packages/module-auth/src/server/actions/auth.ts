import { Context, Next } from '@tego/server';

import { BasicAuth } from '../basic-auth';

// 定义包含 changePassword 方法的接口
interface AuthWithChangePassword {
  changePassword(): Promise<any>;
}

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
      const auth = (await ctx.tego.authManager.get('sms', ctx)) as unknown as AuthWithChangePassword;
      ctx.body = await auth.changePassword();
    } else {
      const auth = (await ctx.tego.authManager.get('Email/Password', ctx)) as BasicAuth;
      ctx.body = await auth.changePassword();
    }
    await next();
  },
};

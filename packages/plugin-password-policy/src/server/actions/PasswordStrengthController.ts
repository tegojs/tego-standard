import { Action, Context, Controller, Inject, Next } from '@tego/server';

import { PasswordStrengthService } from '../services/PasswordStrengthService';

@Controller('passwordStrengthConfig')
export class PasswordStrengthController {
  @Inject(() => PasswordStrengthService)
  passwordStrengthService: PasswordStrengthService;

  @Action('get')
  async getConfig(ctx: Context, next: Next) {
    const repo = ctx.db.getRepository('passwordStrengthConfig');
    const data = await repo.findOne();
    ctx.body = data;
    return next();
  }

  @Action('put')
  async setConfiguration(ctx: Context, next: Next) {
    const params = ctx.action.params;
    let transaction;
    try {
      const transaction = await ctx.db.sequelize.transaction();
      const repo = ctx.db.getRepository('passwordStrengthConfig');
      const existOne = await repo.findOne({
        transaction,
      });
      let data;
      if (!existOne) {
        data = await repo.create({
          values: params.values,
          transaction,
        });
      } else {
        data = await repo.update({
          filterByTk: existOne.id,
          values: params.values,
          transaction,
        });
      }
      await transaction.commit();
      ctx.body = data;
    } catch (err) {
      ctx.tego.logger.error('put password strength config error', err);
      transaction?.rollback();
    }
    return next();
  }
}

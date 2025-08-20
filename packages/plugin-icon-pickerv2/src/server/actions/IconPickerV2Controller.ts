import { Action, Context, Controller, Next } from '@tego/server';

@Controller('iconStorage')
export class IconPickerV2Controller {
  @Action('findOrCreate', { acl: 'loggedIn' })
  async findOrCreate(ctx: Context, next: Next) {
    try {
      const { name, size = '', color = '' } = ctx.action.params || {};
      if (!name) {
        ctx.body = null;
        return await next();
      }

      const repo = ctx.db.getRepository('iconStorage');

      let iconData = await repo.findOne({ filter: { name, color, size } });

      if (!iconData) {
        iconData = await repo.create({ values: { name, color, size } });
      }
      const iconId = iconData?.dataValues?.id ?? null;
      ctx.body = iconId;
    } catch (err) {
      console.error('IconPickerV2Controller findOrCreate error:', err);
      ctx.body = null;
    }
    await next();
  }
}

import { Context, Next, PasswordField } from '@tego/server';

export async function verifyInAction(ctx: Context, next: Next) {
  const { id, password } = ctx.action.params.values;
  const userRepository = ctx.db.getRepository('sharePageConfig');
  const shareConfig = await userRepository.findOne({ filter: { id } });
  if (shareConfig) {
    const field = userRepository.collection.getField<PasswordField>('password');
    const valid = await field.verify(password, shareConfig.password);
    ctx.body = {
      valid,
    };
  }

  await next();
}

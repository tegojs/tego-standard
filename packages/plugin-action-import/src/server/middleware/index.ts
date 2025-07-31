import { Context, koaMulter as multer, Next } from '@tego/server';

export async function importMiddleware(ctx: Context, next: Next) {
  if (ctx.action.actionName !== 'importXlsx') {
    return next();
  }
  const upload = multer().single('file');
  return upload(ctx, next);
}

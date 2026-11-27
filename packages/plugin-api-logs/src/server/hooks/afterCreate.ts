import { Application, Context, Model } from '@tego/server';

export async function handleCreate(ctx: Context, next) {
  await next();
  const { actionName, resourceName, params } = ctx.action;
  const currentTime = new Date().toISOString();
  const apilogsRepo = ctx.db.getRepository('apiLogs');
  const currentUserId = ctx.auth?.user.id;

  const app = ctx.tego as Application;
  const collection = app.mainDataSource.collectionManager.getCollection(ctx.action.resourceName);

  // Selected creates return a minimal receipt instead of the created model.
  // 选中入口的新增响应是最小回执，而非完整业务模型。
  const receiptKey =
    !(ctx.body instanceof Model) &&
    ctx.body?.affected === 1 &&
    Array.isArray(ctx.body.keys) &&
    ctx.body.keys.length === 1
      ? ctx.body.keys[0]
      : undefined;
  const validReceiptKey =
    (typeof receiptKey === 'string' && receiptKey.length > 0) ||
    (typeof receiptKey === 'number' && Number.isFinite(receiptKey));
  const currentRecordId = validReceiptKey ? receiptKey : ctx.body?.[collection.filterTargetKey];
  const changes = [];
  const changed = {
    ...params.values,
    [collection.filterTargetKey]: currentRecordId,
  };
  if (changed) {
    Object.keys(changed).forEach((key: string) => {
      const field = collection.findField((field) => {
        return field.name === key || field.options.field === key;
      });
      if (changed[key] && field && !field.options.hidden) {
        changes.push({
          field: field.options,
          after: changed[key],
        });
      }
    });
  }
  if (!changes.length) {
    return;
  }
  apilogsRepo.create({
    values: {
      action: actionName,
      createdAt: currentTime,
      collectionName: resourceName,
      recordId: currentRecordId,
      userId: currentUserId,
      changes,
    },
    hooks: false,
  });
}

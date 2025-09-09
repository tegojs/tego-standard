export const shareAclAction = async (ctx, next) => {
  if (ctx.action?.resourceName === 'roles' && ctx.action?.actionName === 'check' && ctx.headers['x-role'] === 'guest') {
    const url = new URL(ctx.headers.referer);
    if (url.pathname.split('/').filter(Boolean)?.[0] === 'share') {
      const lastSegment = url.pathname.split('/').pop();
      const shareConfig = await ctx.db.getRepository('sharePageConfig').findOne({ filter: { id: lastSegment } });
      if (shareConfig.permission === 'edit') {
        ctx.body.strategy.actions = ['create', 'view', 'update', 'destroy'];
      } else if (shareConfig.permission === 'view') {
        ctx.body.strategy.actions = ['view'];
      }
    }
  }

  if (
    ctx.action?.resourceName === 'uiSchemas' &&
    ctx.action?.actionName === 'getJsonSchema' &&
    ctx.headers['x-role'] === 'guest'
  ) {
    const url = new URL(ctx.headers.referer);
    const xUid = url.pathname.split('/').slice(-2, -1)[0];
    const lastSegment = url.pathname.split('/').pop();
    if (url.pathname.split('/').filter(Boolean)?.[0] === 'share' && xUid === ctx.action?.params?.filterByTk) {
      const shareConfig = await ctx.db.getRepository('sharePageConfig').findOne({ filter: { id: lastSegment } });
      const shareTabs = shareConfig.tabs
        .map((item) => {
          return item.schemaName;
        })
        .filter(Boolean);
      const bodyProperties = ctx.body.bodyProperties || ctx.body?.properties || {};
      const properties = {};
      for (let key in bodyProperties) {
        if (shareTabs.includes(key)) {
          properties[key] = bodyProperties[key];
        }
      }
      ctx.body.properties = properties;
      ctx.body.bodyProperties = bodyProperties;
    }
  }
  return next();
};

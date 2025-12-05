const map2obj = (map: Map<string, string>) => {
  const obj = {};
  for (const [key, value] of map) {
    obj[key] = value;
  }
  return obj;
};

export async function checkAction(ctx, next) {
  const currentRole = ctx.state.currentRole;

  const roleInstance = await ctx.db.getRepository('roles').findOne({
    filter: {
      name: currentRole,
    },
    appends: ['menuUiSchemas'],
  });

  if (!roleInstance) {
    throw new Error(`Role ${currentRole} not exists`);
  }

  const anonymous = await ctx.db.getRepository('roles').findOne({
    filter: {
      name: 'anonymous',
    },
  });

  let role = ctx.tego.acl.getRole(currentRole);

  if (!role) {
    await ctx.tego.emitAsync('acl:writeRoleToACL', roleInstance);
    role = ctx.tego.acl.getRole(currentRole);
  }

  const availableActions = ctx.tego.acl.getAvailableActions();

  ctx.body = {
    ...role.toJSON(),
    availableActions: [...availableActions.keys()],
    resources: [...role.resources.keys()],
    actionAlias: map2obj(ctx.tego.acl.actionAlias),
    allowAll: currentRole === 'root',
    allowConfigure: roleInstance.get('allowConfigure'),
    allowMenuItemIds: roleInstance.get('menuUiSchemas').map((uiSchema) => uiSchema.get('x-uid')),
    allowAnonymous: !!anonymous,
  };

  await next();
}

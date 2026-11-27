import { RoleResourceActionModel } from '@tachybase/module-acl';
import { ACL, type Database } from '@tego/server';

/** Persistent scope/action models, exercising the ordinary role configuration writer. */
export async function seedAclScopes(db: Database) {
  db.registerModels({ RoleResourceActionModel });
  for (const name of ['rolesResourcesScopes', 'dataSourcesRolesResourcesScopes']) {
    db.collection({
      name,
      timestamps: false,
      fields: [
        { name: 'key', type: 'string' },
        { name: 'dataSourceKey', type: 'string' },
        { name: 'resourceName', type: 'string' },
        { name: 'scope', type: 'json' },
      ],
    });
    db.collection({
      name: `${name}Actions`,
      model: 'RoleResourceActionModel',
      timestamps: false,
      fields: [
        { name: 'name', type: 'string' },
        { name: 'fields', type: 'array' },
        { name: 'scope', type: 'belongsTo', target: name },
      ],
    });
  }
  await db.sync();
}

export async function grantStoredScope(
  db: Database,
  acl: ACL,
  scopeValues: Record<string, unknown> = {},
  scopeCollection = 'dataSourcesRolesResourcesScopes',
) {
  if (!acl.getRole('member')) acl.define({ role: 'member' });
  acl.setAvailableAction('view', { aliases: ['get', 'list'] });
  const scope = await db.getRepository(scopeCollection).create({
    values: {
      key: 'tenant',
      dataSourceKey: 'main',
      scope: { tenantId: '{{ ctx.state.currentTenant.id }}' },
      ...scopeValues,
    },
  });
  const action = await db.getRepository(`${scopeCollection}Actions`).create({
    values: { name: 'view', fields: ['id', 'name'], scopeId: scope.get('id') },
  });
  await action.writeToACL({
    acl,
    role: acl.getRole('member'),
    resourceName: 'documents',
    associationFieldsActions: {},
    grantHelper: {},
  });
  return { action, scope };
}

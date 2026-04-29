import { extendCollection } from '@tego/server';

export default extendCollection({
  name: 'users',
  fields: [
    {
      interface: 'm2m',
      type: 'belongsToMany',
      name: 'tenants',
      target: 'tenants',
      foreignKey: 'userId',
      otherKey: 'tenantId',
      onDelete: 'CASCADE',
      sourceKey: 'id',
      targetKey: 'id',
      through: 'tenantUsers',
    },
    {
      type: 'string',
      name: 'defaultTenantId',
    },
    {
      type: 'belongsTo',
      name: 'defaultTenant',
      target: 'tenants',
      foreignKey: 'defaultTenantId',
      targetKey: 'id',
    },
  ],
});

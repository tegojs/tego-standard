import type { CollectionOptions } from '@tego/server';

export default {
  dumpRules: {
    group: 'workflow',
  },
  name: 'executions',
  shared: true,
  tenancy: 'tenantScoped',
  indexes: [
    {
      name: 'executions_tenant_key_created_at',
      fields: ['tenantId', 'key', 'createdAt'],
    },
  ],
  fields: [
    {
      type: 'belongsTo',
      name: 'workflow',
    },
    {
      type: 'string',
      name: 'key',
    },
    {
      type: 'hasMany',
      name: 'jobs',
      onDelete: 'CASCADE',
    },
    {
      type: 'json',
      name: 'context',
    },
    {
      type: 'string',
      name: 'tenantId',
    },
    {
      type: 'belongsTo',
      name: 'tenant',
      target: 'tenants',
      foreignKey: 'tenantId',
      targetKey: 'id',
      onDelete: 'CASCADE',
    },
    {
      type: 'json',
      name: 'tenantContext',
    },
    {
      type: 'json',
      name: 'authContext',
    },
    {
      type: 'integer',
      name: 'status',
    },
    {
      type: 'bigInt',
      name: 'parentNode',
    },
    {
      type: 'bigInt',
      name: 'executionCost',
    },
    {
      type: 'belongsTo',
      name: 'parent',
      foreignKey: 'parentId',
      treeParent: true,
      target: 'executions',
      sourceKey: 'id',
    },
  ],
} as CollectionOptions;

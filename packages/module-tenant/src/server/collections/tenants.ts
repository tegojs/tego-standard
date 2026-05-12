import { defineCollection } from '@tego/server';

export default defineCollection({
  name: 'tenants',
  dumpRules: 'required',
  fields: [
    {
      type: 'uid',
      name: 'id',
      primaryKey: true,
    },
    {
      type: 'string',
      name: 'name',
      unique: true,
    },
    {
      type: 'string',
      name: 'title',
    },
    {
      type: 'boolean',
      name: 'enabled',
      defaultValue: true,
    },
    {
      type: 'string',
      name: 'parentId',
    },
    {
      type: 'belongsTo',
      name: 'parent',
      target: 'tenants',
      foreignKey: 'parentId',
    },
    {
      type: 'hasMany',
      name: 'children',
      target: 'tenants',
      foreignKey: 'parentId',
    },
    {
      type: 'string',
      name: 'path',
      maxLength: 500,
    },
  ],
});

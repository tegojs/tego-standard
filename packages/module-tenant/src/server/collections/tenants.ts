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
      allowNull: false,
      required: true,
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
      index: true,
    },
    {
      type: 'belongsTo',
      name: 'parent',
      target: 'tenants',
      foreignKey: 'parentId',
      treeParent: true,
      onDelete: 'RESTRICT',
    },
    {
      type: 'hasMany',
      name: 'children',
      target: 'tenants',
      foreignKey: 'parentId',
      treeChildren: true,
      onDelete: 'RESTRICT',
    },
    {
      type: 'string',
      name: 'path',
      maxLength: 500,
      index: true,
    },
  ],
});

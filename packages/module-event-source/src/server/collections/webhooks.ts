import { defineCollection } from '@tego/server';

export default defineCollection({
  name: 'webhooks',
  dumpRules: {
    group: 'required',
  },
  model: 'EventSourceModel',
  createdAt: true,
  updatedAt: true,
  createdBy: true,
  updatedBy: true,
  fields: [
    {
      name: 'name',
      unique: true,
      type: 'string',
    },
    {
      name: 'enabled',
      type: 'boolean',
    },
    {
      name: 'workflowKey',
      type: 'string',
    },
    {
      type: 'belongsToMany',
      name: 'category',
      target: 'webhookCategories',
      sourceKey: 'id',
      foreignKey: 'webhookId',
      otherKey: 'categoryId',
      targetKey: 'id',
      sortBy: 'sort',
      through: 'webhookCategory',
    },
    {
      name: 'type', // code/plugin
      type: 'string',
    },
    {
      name: 'code',
      type: 'text',
    },
    {
      name: 'settings',
      type: 'json',
    },
    {
      name: 'triggerOnAssociation',
      type: 'boolean',
    },
    {
      name: 'actionName',
      type: 'string',
    },
    {
      name: 'resourceName',
      type: 'text',
    },
    {
      name: 'eventName',
      type: 'string',
    },
    {
      name: 'options',
      type: 'json',
    },
    {
      name: 'effect',
      type: 'virtual',
    },
    {
      name: 'effectConfig',
      type: 'virtual',
    },
  ],
});

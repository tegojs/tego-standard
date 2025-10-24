import { defineCollection } from '@tego/server';

export default defineCollection({
  dumpRules: { group: 'required' },
  shared: true,
  name: 'webhookCategories',
  autoGenId: true,
  sortable: true,
  createdAt: true,
  updatedAt: true,
  createdBy: true,
  updatedBy: true,
  fields: [
    {
      type: 'string',
      name: 'name',
      translation: true,
    },
    {
      type: 'string',
      name: 'color',
      defaultValue: 'default',
    },
    {
      type: 'belongsToMany',
      name: 'webhooks',
      target: 'webhooks',
      foreignKey: 'categoryId',
      otherKey: 'webhookId',
      targetKey: 'id',
      through: 'webhookCategory',
    },
  ],
});

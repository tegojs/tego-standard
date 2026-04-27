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
  ],
});

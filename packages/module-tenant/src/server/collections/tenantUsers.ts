import { defineCollection } from '@tego/server';

export default defineCollection({
  name: 'tenantUsers',
  dumpRules: 'required',
  fields: [
    {
      type: 'string',
      name: 'tenantId',
      primaryKey: true,
    },
    {
      type: 'bigInt',
      name: 'userId',
      primaryKey: true,
    },
    {
      type: 'boolean',
      name: 'default',
      defaultValue: false,
    },
  ],
});

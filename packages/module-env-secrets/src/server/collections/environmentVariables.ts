import { defineCollection } from '@tego/server';

export default defineCollection({
  name: 'environmentVariables',
  autoGenId: false,
  fields: [
    {
      type: 'string',
      name: 'name',
      primaryKey: true,
    },
    {
      type: 'string',
      name: 'type',
    },
    {
      type: 'text',
      name: 'value',
    },
  ],
});

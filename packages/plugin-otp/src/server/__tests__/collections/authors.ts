import { CollectionOptions } from '@tego/server';

export default {
  name: 'authors',
  fields: [
    {
      type: 'string',
      name: 'title',
    },
    {
      type: 'string',
      name: 'phone',
    },
  ],
} as CollectionOptions;

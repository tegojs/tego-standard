import { CollectionOptions } from '@tego/server';

export default {
  name: 'categories',
  fields: [
    {
      type: 'string',
      name: 'title',
    },
    {
      type: 'hasMany',
      name: 'posts',
    },
  ],
} as CollectionOptions;

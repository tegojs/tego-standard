import { CollectionOptions } from '@tego/server';

export default {
  name: 'tags',
  fields: [
    {
      type: 'belongsToMany',
      name: 'posts',
    },
    {
      type: 'string',
      name: 'name',
    },
  ],
} as CollectionOptions;

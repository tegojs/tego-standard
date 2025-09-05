import { CollectionOptions } from '@tego/server';

export default {
  name: 'iconStorage',
  shared: true,
  createdAt: false,
  updatedAt: false,
  createdBy: false,
  updatedBy: false,
  fields: [
    {
      type: 'string',
      name: 'name',
    },
    {
      type: 'string',
      name: 'color',
    },
    {
      type: 'string',
      name: 'size',
    },
  ],
} as CollectionOptions;

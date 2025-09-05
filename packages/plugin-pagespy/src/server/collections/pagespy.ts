import { CollectionOptions } from '@tego/server';

export default {
  name: 'pagespy',
  shared: true,
  createdAt: false,
  updatedAt: false,
  createdBy: false,
  updatedBy: false,
  fields: [
    {
      type: 'string',
      name: 'api',
    },
    {
      type: 'string',
      name: 'project',
    },
    {
      type: 'string',
      name: 'title',
    },
  ],
} as CollectionOptions;

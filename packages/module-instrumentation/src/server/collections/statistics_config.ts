import { CollectionOptions } from '@tego/server';

export default {
  dumpRules: {
    group: 'required',
  },
  name: 'statisticsConfig',
  createdBy: false,
  updatedBy: false,
  updatedAt: false,
  createdAt: false,
  shared: true,
  model: 'CollectionModel',
  fields: [
    {
      type: 'string',
      name: 'title',
    },
    {
      type: 'jsonb',
      name: 'statisticsOptions',
    },
  ],
} as CollectionOptions;

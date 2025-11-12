import { CollectionOptions } from '@tego/server';

export default {
  dumpRules: {
    group: 'required',
  },
  name: 'trackingHistoryOptions',
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
      name: 'historyOptions',
    },
  ],
} as CollectionOptions;

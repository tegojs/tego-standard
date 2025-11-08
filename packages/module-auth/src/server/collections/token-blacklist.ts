import { defineCollection } from '@tego/server';

export default defineCollection({
  dumpRules: {
    group: 'user',
  },
  shared: true,
  name: 'tokenBlacklist',
  model: 'TokenBlacklistModel',
  fields: [
    {
      type: 'string',
      name: 'token',
      index: true,
      length: 512,
    },
    {
      type: 'date',
      name: 'expiration',
    },
  ],
});

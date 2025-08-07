import { extendCollection } from '@tego/server';

export default extendCollection({
  name: 'categories',
  fields: [
    {
      type: 'string',
      name: 'engine',
    },
    {
      type: 'string',
      name: 'collection',
    },
    {
      type: 'text',
      name: 'expression',
    },
  ],
});

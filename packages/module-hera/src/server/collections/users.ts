import { extendCollection } from '@tego/server';

export default extendCollection({
  name: 'users',
  fields: [
    {
      type: 'belongsTo',
      name: 'defaultPrintStyle',
      target: 'printStyles',
    },
  ],
});

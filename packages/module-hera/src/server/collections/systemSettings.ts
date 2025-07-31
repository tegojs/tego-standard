import { extendCollection } from '@tego/server';

export default extendCollection({
  name: 'systemSettings',
  fields: [
    {
      type: 'json',
      name: 'features',
      defaultValue: [],
    },
  ],
});

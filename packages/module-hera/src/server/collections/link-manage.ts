import { defineCollection } from '@tego/server';

export default defineCollection({
  dumpRules: {
    group: 'required',
  },
  name: 'linkManage',
  title: '链接管理',
  fields: [
    {
      title: 'Name',
      name: 'name',
      type: 'string',
    },
    {
      title: 'Link',
      name: 'link',
      type: 'string',
    },
  ],
});

import { ISchema } from '@tachybase/schema';

export const webhookCategories = {
  name: 'webhookCategories',
  fields: [
    {
      type: 'string',
      name: 'name',
      interface: 'input',
      uiSchema: {
        title: '{{t("Name")}}',
        type: 'string',
        'x-component': 'Input',
      } as ISchema,
    },
  ],
};

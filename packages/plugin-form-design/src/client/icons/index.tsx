import { Icon } from '@tachybase/client';

import { AddFields } from './AddFields';

const AddFieldsIcon = (props: any) => <Icon component={AddFields} {...props} />;

Icon.register({
  'add-fields': AddFieldsIcon,
});

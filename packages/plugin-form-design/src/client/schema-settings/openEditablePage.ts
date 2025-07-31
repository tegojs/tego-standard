import { useCollection_deprecated } from '@tachybase/client';

export const openEditablePage = {
  name: 'openEditablePage',
  Component: 'SchemaSettingsEditablePage',
  useComponentProps() {
    const { name } = useCollection_deprecated();
    return {
      collectionName: name,
    };
  },
};

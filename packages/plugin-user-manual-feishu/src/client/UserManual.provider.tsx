import { PinnedPluginListProvider, SchemaComponentOptions } from '@tachybase/client';

import { UserManualLink } from './UserManualLink';

export const ProviderUserManual = (props) => {
  return (
    <PinnedPluginListProvider
      items={{
        userManual: {
          order: 50,
          component: 'UserManualLink',
          pin: true,
          isPublic: true,
          belongTo: 'pinnedmenu',
        },
      }}
    >
      <SchemaComponentOptions
        components={{
          UserManualLink,
        }}
      >
        {props.children}
      </SchemaComponentOptions>
    </PinnedPluginListProvider>
  );
};

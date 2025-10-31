import React from 'react';
import { SchemaComponent, SchemaComponentContext, useSchemaComponentContext } from '@tachybase/client';

import { useUsersTranslation } from './locale';
import { userStatusesSchema } from './schemas/userStatuses';

export const UserStatusManagement = () => {
  const { t } = useUsersTranslation();
  const scCtx = useSchemaComponentContext();
  return (
    <SchemaComponentContext.Provider value={{ ...scCtx, designable: false }}>
      <SchemaComponent schema={userStatusesSchema} scope={{ t }} />
    </SchemaComponentContext.Provider>
  );
};

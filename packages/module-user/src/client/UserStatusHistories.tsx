import React from 'react';
import { SchemaComponent, SchemaComponentContext, useSchemaComponentContext } from '@tachybase/client';

import { useUsersTranslation } from './locale';
import { userStatusHistoriesSchema } from './schemas/userStatusHistories';

export const UserStatusHistories = () => {
  const { t } = useUsersTranslation();
  const scCtx = useSchemaComponentContext();
  return (
    <SchemaComponentContext.Provider value={{ ...scCtx, designable: false }}>
      <SchemaComponent schema={userStatusHistoriesSchema} scope={{ t }} />
    </SchemaComponentContext.Provider>
  );
};

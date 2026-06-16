import React, { useMemo } from 'react';
import { ISchema, uid } from '@tachybase/schema';

import { useTranslation } from 'react-i18next';

import { ApplicationContext } from '../../../../application/context';
import { SchemaInitializer } from '../../../../application/schema-initializer/SchemaInitializer';
import { SchemaInitializerManager } from '../../../../application/schema-initializer/SchemaInitializerManager';
import { SchemaComponent } from '../../../../schema-component/core/SchemaComponent';
import { SchemaComponentProvider } from '../../../../schema-component/core/SchemaComponentProvider';
import { Grid } from '../Grid';

const schema: ISchema = {
  type: 'object',
  properties: {
    grid: {
      type: 'void',
      'x-component': 'Grid',
      'x-initializer': 'addBlockButton',
      'x-uid': uid(),
      properties: {},
    },
  },
};

function Root() {
  const { t } = useTranslation();
  const schemaInitializerManager = useMemo(() => {
    const addBlockButton = new SchemaInitializer({
      name: 'addBlockButton',
      title: t('Add block'),
      items: [],
    });

    return new SchemaInitializerManager([addBlockButton], {} as any);
  }, [t]);

  return (
    <ApplicationContext.Provider value={{ schemaInitializerManager } as any}>
      <SchemaComponentProvider designable components={{ Grid }}>
        <SchemaComponent schema={schema} />
      </SchemaComponentProvider>
    </ApplicationContext.Provider>
  );
}

export default function App() {
  return <Root />;
}

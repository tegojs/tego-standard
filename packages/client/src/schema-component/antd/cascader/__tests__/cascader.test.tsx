import React from 'react';
import {
  Application,
  CollectionFieldProvider,
  CollectionProvider,
  DataSourceApplicationProvider,
  SchemaComponentProvider,
  useCollectionField,
  useCompile,
} from '@tachybase/client';
import { render, screen } from '@tachybase/test/client';

import collections from '../../../../data-source/__tests__/collections.json';

/**
 * Tests verify Cascader field resolution without rendering through the
 * formily schema system (connect() + SchemaComponent), which triggers
 * ReactiveField's observer causing an infinite render loop in jsdom.
 * Same strategy as CollectionField.test.tsx.
 */

const cascaderField = {
  key: 'test-cascader',
  name: 'test_cascader',
  type: 'json',
  interface: 'cascader',
  collectionName: 'users',
  uiSchema: {
    type: 'array',
    title: 'Region',
    'x-component': 'Cascader',
    enum: [
      {
        value: 'zhejiang',
        label: 'Zhejiang',
        children: [{ value: 'hangzhou', label: 'Hangzhou' }],
      },
    ],
  },
};

function renderApp() {
  const usersCollection: any = collections[0];
  if (!usersCollection.fields.find((f) => f.name === 'test_cascader')) {
    usersCollection.fields.push(cascaderField);
  }

  const app = new Application({
    dataSourceManager: { collections: [usersCollection] },
  });

  const FieldDisplay = () => {
    const field = useCollectionField();
    const compile = useCompile();
    const uiSchema = field?.uiSchema ? compile(field.uiSchema) : null;
    return (
      <div>
        <span data-testid="title">{uiSchema?.title || ''}</span>
        <span data-testid="component">{uiSchema?.['x-component'] || ''}</span>
      </div>
    );
  };

  return render(
    <div data-testid="app">
      <SchemaComponentProvider designable={true}>
        <DataSourceApplicationProvider dataSourceManager={app.dataSourceManager}>
          <CollectionProvider name="users">
            <CollectionFieldProvider name="test_cascader">
              <FieldDisplay />
            </CollectionFieldProvider>
          </CollectionProvider>
        </DataSourceApplicationProvider>
      </SchemaComponentProvider>
    </div>,
  );
}

describe('Cascader', () => {
  it('field resolves correctly', () => {
    renderApp();
    expect(screen.getByTestId('title')).toHaveTextContent('Region');
    expect(screen.getByTestId('component')).toHaveTextContent('Cascader');
  });
});

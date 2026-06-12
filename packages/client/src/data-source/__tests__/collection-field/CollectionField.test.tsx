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

import collections from '../collections.json';

/**
 * Test helper that renders a collection field and displays its resolved UI schema info.
 * Uses CollectionFieldProvider directly instead of going through CollectionField's
 * connect() wrapper, which would trigger formily's ReactiveField observer and cause
 * an infinite render loop in the test environment.
 */
function renderApp(fieldName: string) {
  const noUiSchema = {
    key: 'no-ui-schema',
    name: 'no-ui-schema',
    type: 'string',
    interface: 'select',
    description: null,
    collectionName: 't_vwpds9fs4xs',
    parentKey: null,
    reverseKey: null,
  };

  const usersCollection: any = collections[0];
  if (!usersCollection.fields.find((f) => f.name === 'no-ui-schema')) {
    usersCollection.fields.push(noUiSchema);
  }

  const app = new Application({
    dataSourceManager: {
      collections: [usersCollection],
    },
  });

  const FieldDisplay = () => {
    const field = useCollectionField();
    const compile = useCompile();
    const uiSchema = field?.uiSchema ? compile(field.uiSchema) : null;
    const title = uiSchema?.title || '';
    const component = uiSchema?.['x-component'] || '';
    return (
      <div>
        <span data-testid="title">{title}</span>
        <span data-testid="component">{component}</span>
      </div>
    );
  };

  return render(
    <div data-testid="app">
      <SchemaComponentProvider designable={true}>
        <DataSourceApplicationProvider dataSourceManager={app.dataSourceManager}>
          <CollectionProvider name="users">
            <CollectionFieldProvider name={fieldName}>
              <FieldDisplay />
            </CollectionFieldProvider>
          </CollectionProvider>
        </DataSourceApplicationProvider>
      </SchemaComponentProvider>
    </div>,
  );
}

describe('CollectionField', () => {
  it('works', () => {
    renderApp('nickname');
    expect(screen.getByTestId('title')).toHaveTextContent('Nickname');
    expect(screen.getByTestId('component')).toHaveTextContent('Input');
  });

  it('no schema', () => {
    renderApp('no-ui-schema');
    expect(screen.getByTestId('title')).toHaveTextContent('');
    expect(screen.getByTestId('component')).toHaveTextContent('');
  });
});

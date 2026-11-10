import React, { useState } from 'react';
import {
  Application,
  CardItem,
  CollectionPlugin,
  CollectionRecordProvider,
  FormBlockProvider,
  FormV2,
  Input,
  LocalDataSource,
  Plugin,
  SchemaComponent,
  useFormBlockProps,
} from '@tachybase/client';
import { ISchema } from '@tachybase/schema';
import { fireEvent, render, screen, waitFor } from '@tachybase/test/client';

import MockAdapter from 'axios-mock-adapter';
import { useLocation } from 'react-router-dom';

import { useCreateActionProps } from '..';

const schema: ISchema = {
  type: 'void',
  name: 'createTask',
  'x-decorator': 'FormBlockProvider',
  'x-component': 'CardItem',
  'x-decorator-props': { collection: 'navigationTasks', dataSource: 'main' },
  properties: {
    form: {
      type: 'void',
      'x-component': 'FormV2',
      'x-use-component-props': 'useFormBlockProps',
      properties: {
        name: { type: 'string', 'x-component': 'Input', default: 'Draft' },
        submit: {
          type: 'void',
          'x-component': 'SubmitProbe',
          'x-action-settings': { pageMode: true },
          properties: {
            details: { type: 'void', 'x-component': 'Action.Container', 'x-uid': 'task-details' },
          },
        },
      },
    },
  },
};

function SubmitProbe() {
  const { onClick } = useCreateActionProps();
  const [outcome, setOutcome] = useState('ready');
  return (
    <>
      <button
        onClick={async () => {
          try {
            await onClick();
            setOutcome('submitted');
          } catch (error) {
            setOutcome(String(error));
          }
        }}
      >
        Save task
      </button>
      <output data-testid="submission">{outcome}</output>
    </>
  );
}

function Page() {
  const location = useLocation();
  return (
    <>
      <output data-testid="location">{location.pathname}</output>
      <CollectionRecordProvider isNew>
        <SchemaComponent schema={schema} />
      </CollectionRecordProvider>
    </>
  );
}

describe('create form detail-page navigation', () => {
  let mock: MockAdapter;

  afterEach(() => {
    mock?.restore();
  });

  async function openForm(body: unknown, keyType = 'integer') {
    class TaskCollections extends Plugin {
      async load() {
        this.app.dataSourceManager.addDataSource(LocalDataSource, {
          key: 'main',
          displayName: 'Main',
          collections: [
            {
              name: 'navigationTasks',
              fields: [
                { name: 'id', type: keyType, primaryKey: true },
                { name: 'name', type: 'string' },
              ],
            },
          ],
        });
      }
    }

    const app = new Application({
      apiClient: { baseURL: 'http://localhost:8000' },
      router: { type: 'memory', initialEntries: ['/'] },
      providers: [Page],
      components: { CardItem, FormBlockProvider, FormV2, Input, SubmitProbe },
      scopes: { useFormBlockProps },
      plugins: [CollectionPlugin, TaskCollections],
      designable: false,
    });
    mock = new MockAdapter(app.apiClient.axios);
    mock.onPost('navigationTasks:create').reply(200, body);
    const Root = app.getRootComponent();
    render(<Root />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save task' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await waitFor(() => expect(screen.getByTestId('submission')).toHaveTextContent('submitted'));
    expect(mock.history.post).toHaveLength(1);
    expect(JSON.parse(mock.history.post[0].data)).toEqual({ name: 'Draft' });
    return app;
  }

  // Reading only the legacy id would navigate without the newly created record key.
  // 仅读取旧记录的 id 会令新权限回执的详情跳转丢失主键。
  it('opens the created record from the selected single-row mutation receipt', async () => {
    await openForm({ data: { keys: [42], affected: 1 } });
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/task-details/collection/navigationTasks/filter-by-tk/42',
      ),
    );
  });

  it('preserves navigation for the original record response', async () => {
    await openForm({ data: { id: 42, name: 'Draft' } });
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/task-details/collection/navigationTasks/filter-by-tk/42',
      ),
    );
  });

  it('preserves the legacy id when a record has a business keys field', async () => {
    await openForm({ data: { id: 42, name: 'Draft', keys: ['business-key'] } });
    expect(screen.getByTestId('location').textContent).toBe('/task-details/collection/navigationTasks/filter-by-tk/42');
  });

  it.each([
    { key: '001', keyType: 'string', path: '/task-details/collection/navigationTasks/filter-by-tk/001' },
    { key: 0, keyType: 'integer', path: '/task-details/collection/navigationTasks/filter-by-tk/0' },
  ])('preserves the complete created key $key', async ({ key, keyType, path }) => {
    await openForm({ data: { keys: [key], affected: 1 } }, keyType);
    expect(screen.getByTestId('location').textContent).toBe(path);
  });

  // A missing or ambiguous receipt must not open an unbound detail page.
  // 缺失或含糊的回执不得打开没有记录定位的详情页。
  it.each([
    { label: 'no affected record', receipt: { keys: [], affected: 0 } },
    { label: 'multiple affected records', receipt: { keys: [41, 42], affected: 2 } },
    { label: 'inconsistent affected count', receipt: { keys: [42], affected: 0 } },
    { label: 'non-scalar key', receipt: { keys: [{ id: 42 }], affected: 1 } },
  ])('stays on the form for $label', async ({ receipt }) => {
    await openForm({ data: receipt });
    expect(screen.getByTestId('location').textContent).toBe('/');
  });
});

import { createMockServer, type MockServer } from '@tachybase/test';

import PluginHeraServer from '../plugin';

describe('legacy print style compatibility', () => {
  let app: MockServer;

  beforeAll(async () => {
    app = await createMockServer({
      plugins: [
        'users',
        [
          PluginHeraServer,
          {
            name: 'hera',
            packageName: '@tachybase/module-hera',
            workspaceSource: true,
          },
        ],
      ],
    });
  });

  afterAll(async () => {
    await app.destroy();
  });

  it('keeps the print style association used by cloud components', async () => {
    const printStyle = await app.db.getRepository('printStyles').create({
      values: {
        name: 'Default',
        margin: {},
        size: 'A4',
        fontSize: '12',
        orientation: 'portrait',
        column: '1',
        comment: '',
      },
    });
    const user = await app.db.getRepository('users').create({
      values: {
        username: 'print-style-user',
        defaultPrintStyleId: printStyle.get('id'),
      },
    });

    expect(app.db.getCollection('users').getField('defaultPrintStyle')).toBeTruthy();

    const response = await app
      .agent()
      .resource('users')
      .get({
        filter: { id: user.get('id') },
        appends: ['defaultPrintStyle'],
      });

    expect(response.status).toBe(200);
    expect(response.body.data.defaultPrintStyle.id).toBe(printStyle.get('id'));
  });
});

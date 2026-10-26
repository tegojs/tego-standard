import { createMockServer, type MockServer } from '@tachybase/test';
import type { Context } from '@tego/server';

import xlsx from 'node-xlsx';

import ImportPlugin, { createImportXlsx, type ImportPluginOptions, type ImportXlsxResolver } from '..';

describe('server-selected XLSX import entry', () => {
  let app: MockServer;
  let collectionName: string;
  let sequence = 0;
  const workbook = xlsx.build([{ name: 'Import', data: [['Title'], ['Original spreadsheet row']] }]);

  beforeEach(async () => {
    app = await createMockServer({
      registerActions: true,
      acl: false,
      database: { dialect: 'sqlite' },
      plugins: ['acl', 'error-handler', 'users', 'auth', 'data-source-manager', 'collection-manager'],
    });
    collectionName = `selected_import_${++sequence}`;
    app.db.collection({ name: collectionName, fields: [{ name: 'title', type: 'string' }] });
    await app.db.sync();
  });
  afterEach(async () => {
    await app?.destroy();
  });

  const register = async (options: Partial<ImportPluginOptions> = {}) => {
    const plugin = new ImportPlugin(app, { name: 'selected-import', ...options });
    await plugin.beforeLoad();
    await plugin.load();
    return plugin;
  };
  const request = () =>
    app
      .agent()
      .post(`/${collectionName}:importXlsx`)
      .attach('file', workbook, { filename: 'import.xlsx' })
      .field('columns', JSON.stringify([{ dataIndex: ['title'], defaultTitle: 'Title' }]));
  const titles = async () =>
    (await app.db.getRepository(collectionName).find({ sort: ['id'] })).map((row) => row.get('title'));
  const selected: ImportXlsxResolver = () => async (ctx) => {
    expect(ctx.file.buffer).toEqual(workbook);
    expect(JSON.parse(ctx.request.body.columns)).toEqual([{ dataIndex: ['title'], defaultTitle: 'Title' }]);
    await ctx.db.getRepository(ctx.action.resourceName).create({ values: { title: 'Selected executor row' } });
    ctx.body = { selected: true };
  };

  it.each([{}, { importResolver: () => undefined }])('preserves the original importer for %j', async (options) => {
    await register(options);
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.body.meta).toMatchObject({ successCount: 1, failureCount: 0 });
    expect(await titles()).toEqual(['Original spreadsheet row']);
  });

  it('passes the uploaded request to the selected executor without running the original importer', async () => {
    await register({ importResolver: selected });
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ selected: true });
    expect(await titles()).toEqual(['Selected executor row']);
  });

  it('selects the executor before the original spreadsheet and column parsers run', async () => {
    await register({
      importResolver: () => async (ctx) => {
        ctx.body = { file: ctx.file.buffer.toString(), columns: ctx.request.body.columns };
      },
    });
    const response = await app
      .agent()
      .post(`/${collectionName}:importXlsx`)
      .attach('file', Buffer.from('Executor-owned file format'), { filename: 'import.xlsx' })
      .field('columns', 'Not JSON');
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ file: 'Executor-owned file format', columns: 'Not JSON' });
    expect(await titles()).toEqual([]);
  });

  it('keeps the resolver captured at registration when options change', async () => {
    const plugin = await register({ importResolver: selected });
    plugin.options.importResolver = () => undefined;
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ selected: true });
    expect(await titles()).toEqual(['Selected executor row']);
  });

  it('does not activate a resolver added after registration', async () => {
    const plugin = await register();
    plugin.options.importResolver = selected;
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.body.meta).toMatchObject({ successCount: 1, failureCount: 0 });
    expect(await titles()).toEqual(['Original spreadsheet row']);
  });

  it.each(['selection', 'execution', 'async selection'])(
    'does not run the original importer after %s failure',
    async (phase) => {
      await register({
        importResolver: (() => {
          if (phase === 'selection') throw new Error('Import selection failed');
          if (phase === 'async selection') return Promise.reject(new Error('Async import selection failed'));
          return async () => {
            throw new Error('Import execution failed');
          };
        }) as ImportXlsxResolver,
      });
      const response = await request();
      expect(response.status).toBe(500);
      expect(response.body.errors[0].message).toMatch(
        /(?:Import selection|Import execution|Async import selection) failed/,
      );
      expect(await titles()).toEqual([]);
    },
  );

  it('does not fall back when the selected executor produces no response', async () => {
    await register({ importResolver: () => async () => {} });
    expect((await request()).status).toBe(200);
    expect(await titles()).toEqual([]);
  });

  it('preserves the selected executor transaction rollback without starting the original import', async () => {
    await register({
      importResolver: () => async (ctx) => {
        await ctx.db.sequelize.transaction(async (transaction) => {
          await ctx.db.getRepository(ctx.action.resourceName).create({
            values: { title: 'Rolled back row' },
            transaction,
          });
          throw new Error('Selected import rolled back');
        });
      },
    });
    const response = await request();
    expect(response.status).toBe(500);
    expect(response.body.errors[0].message).toContain('Selected import rolled back');
    expect(await titles()).toEqual([]);
  });

  it.each([null, false, {}, 'import', 'async undefined'])(
    'rejects invalid selection %j without importing rows',
    async (value) => {
      await register({
        importResolver: (() =>
          value === 'async undefined' ? Promise.resolve(undefined) : value) as ImportXlsxResolver,
      });
      const response = await request();
      expect(response.status).toBe(500);
      expect(response.body.errors[0].message).toContain('Import resolver must select an executor or undefined');
      expect(await titles()).toEqual([]);
    },
  );

  it.each([null, false, {}, 'import'])(
    'rejects invalid startup selection %j before replacing the active handler',
    async (value) => {
      await register({ importResolver: selected });
      await expect(register({ importResolver: value as unknown as ImportXlsxResolver })).rejects.toThrow(TypeError);
      const response = await request();
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ selected: true });
      expect(await titles()).toEqual(['Selected executor row']);
    },
  );

  it.each(['selection', 'execution'])('propagates the original %s exception without wrapping it', async (phase) => {
    const failure = new Error('Original import failure');
    const handler = createImportXlsx(() => {
      if (phase === 'selection') throw failure;
      return async () => {
        throw failure;
      };
    });
    await expect(handler({} as Context, async () => {})).rejects.toBe(failure);
  });
});

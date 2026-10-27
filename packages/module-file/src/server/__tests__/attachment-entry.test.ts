import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mockServer, supertest, type MockServer } from '@tachybase/test';
import { Resourcer, type Context } from '@tego/server';

import FilePlugin, {
  createAttachmentActionEntry,
  withStagedAttachmentUpload,
  type AttachmentActionResolver,
  type FileManagerPluginOptions,
} from '..';
import ErrorPlugin from '../../../../module-error-handler/src/server';
import initFileActions from '../actions';
import storageDefinition from '../collections/storages';
import storageTypes, { getStorageConfig } from '../storages';

describe('server-selected attachment storage entry', () => {
  let app: MockServer;
  let directory: string;
  let roleName: string;
  const bytes = Buffer.from('Isolated attachment entry test');

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tego-attachment-entry-'));
    app = mockServer({
      acl: false,
      registerActions: true,
      database: { dialect: 'sqlite', storage: ':memory:' },
      resourcer: { prefix: '/api' },
    });
    const errors = new ErrorPlugin(app, { name: 'test-errors' });
    await errors.beforeLoad();
    await errors.load();
    app.acl.setAvailableAction('upload', { type: 'new-data' });
    app.acl.define({ role: 'editor' });
    for (const action of ['files:create', 'files:upload', 'files:destroy', 'files:get', 'documents:create'])
      app.acl.getRole('editor').grantAction(action, {});
    app.acl.define({ role: 'denied' });
    roleName = 'editor';
    app.resourcer.use(
      async (ctx, next) => {
        ctx.state.currentRole = roleName;
        ctx.state.currentUser = { id: 28 };
        await next();
      },
      { tag: 'attachment-test-principal', before: 'acl', after: 'auth' },
    );
    app.resourcer.use(app.acl.middleware(), { tag: 'acl', after: 'attachment-test-principal' });
  });
  afterEach(async () => {
    await app?.destroy();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });
  async function register(options: Partial<FileManagerPluginOptions> = {}) {
    await app.pm.add(FilePlugin, { name: 'file-manager', ...options });
    const plugin = app.pm.get(FilePlugin);
    await plugin.beforeLoad();
    app.db.collection(storageDefinition);
    app.db.collection({
      name: 'files',
      template: 'file',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true, autoIncrement: true },
        ...['title', 'filename', 'path', 'url', 'mimetype', 'extname'].map((name) => ({ name, type: 'string' })),
        { name: 'size', type: 'integer' },
        { name: 'meta', type: 'jsonb' },
        { name: 'storageId', type: 'integer' },
      ],
    });
    app.db.collection({ name: 'documents', timestamps: false, fields: [{ name: 'title', type: 'string' }] });
    await app.db.sync();
    await plugin.load();
    await app.db.getRepository('storages').create({
      values: {
        name: 'local',
        type: 'local',
        default: true,
        baseUrl: '/isolated-file-tests',
        path: '',
        options: { documentRoot: directory },
        rules: {},
        paranoid: false,
      },
    });
    return plugin;
  }
  const upload = (action = 'upload', marker?: string) => {
    const req = supertest(app.callback()).post(`/api/files:${action}${marker ? `?marker=${marker}` : ''}`);
    return req.attach('file', bytes, { filename: 'test.txt' });
  };
  const stored = () => fs.readdir(directory);
  const records = () => app.db.getCollection('files').model.count();
  async function seedFile() {
    await fs.writeFile(path.join(directory, 'retained.txt'), bytes);
    return app.db.getRepository('files').create({
      values: {
        title: 'Existing',
        filename: 'retained.txt',
        path: '',
        storageId: (await app.db.getRepository('storages').findOne()).get('id'),
      },
    });
  }
  const selected: AttachmentActionResolver = () => async (ctx) => {
    ctx.body = { selected: true, action: ctx.action.actionName };
  };

  it.each([{}, { attachmentResolver: () => undefined }])(
    'preserves physical upload and create for %j',
    async (options) => {
      await register(options);
      for (const action of ['upload', 'create']) {
        const response = await upload(action);
        expect(response.status).toBe(200);
        expect(await fs.readFile(path.join(directory, response.body.data.filename))).toEqual(bytes);
      }
      expect(await records()).toBe(2);
      expect(await stored()).toHaveLength(2);
    },
  );
  it.each(['upload', 'create'])('skips original physical %s and metadata creation when selected', async (action) => {
    await register({ attachmentResolver: selected });
    const response = await upload(action);
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ selected: true, action });
    expect(await records()).toBe(0);
    expect(await stored()).toEqual([]);
  });
  it('preserves storage rules finalized while the legacy upload engine is constructed', async () => {
    await register();
    const local = getStorageConfig('local');
    storageTypes.register('attachment-finalized-rules-test', {
      ...local,
      make(storage) {
        Object.assign(storage, { rules: { mimetype: 'image/*' } });
        return local.make(storage);
      },
    });
    await app.db.getRepository('storages').update({
      filter: { default: true },
      values: { type: 'attachment-finalized-rules-test' },
    });
    expect((await upload()).status).toBe(400);
    expect(await records()).toBe(0);
    expect(await stored()).toEqual([]);
  });
  it('gives the selected executor the original action finalized by ACL', async () => {
    await register({
      attachmentResolver:
        () => async (ctx: Context & { permission?: { can?: { role: string; resource: string; action: string } } }) => {
          ctx.body = { decision: ctx.permission?.can, role: ctx.state.currentRole };
        },
    });
    const response = await upload();
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      role: 'editor',
      decision: { role: 'editor', resource: 'files', action: 'upload' },
    });
    expect(await stored()).toEqual([]);
  });
  it('stages an actual selected upload after final ACL without entering the original storage writer', async () => {
    await register({
      attachmentResolver: () => async (ctx) => {
        ctx.body = await withStagedAttachmentUpload(ctx, { directory, maxFileSize: 1024 }, async (file) => {
          expect(await fs.readFile(file.path)).toEqual(bytes);
          return { size: file.size, permittedAction: ctx.permission.can.action };
        });
      },
    });
    const response = await upload();
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ size: bytes.length, permittedAction: 'upload' });
    expect(await stored()).toEqual([]);
    expect(await records()).toBe(0);
  });
  it('does not execute or write physical files when final ACL denies the action', async () => {
    await register({
      attachmentResolver: () => async () => {
        throw new Error('Executor must not run');
      },
    });
    roleName = 'denied';
    const response = await upload();
    expect(response.status).toBe(403);
    expect(await stored()).toEqual([]);
    expect(await records()).toBe(0);
  });
  it('skips original physical deletion and row deletion when selected', async () => {
    await register({ attachmentResolver: selected });
    const record = await seedFile();
    const response = await supertest(app.callback()).post(`/api/files:destroy?filterByTk=${record.get('id')}`);
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ selected: true, action: 'destroy' });
    expect(await records()).toBe(1);
    expect(await fs.readFile(path.join(directory, 'retained.txt'))).toEqual(bytes);
  });
  it.each([{}, { attachmentResolver: () => undefined }])(
    'preserves original physical deletion for %j',
    async (options) => {
      await register(options);
      const record = await seedFile();
      const response = await supertest(app.callback()).post(`/api/files:destroy?filterByTk=${record.get('id')}`);
      expect([200, 204]).toContain(response.status);
      expect(await records()).toBe(0);
      expect(await stored()).toEqual([]);
    },
  );
  it.each(['selection', 'execution', 'async selection'])(
    'propagates %s failure without storing a file',
    async (phase) => {
      await register({
        attachmentResolver: (() => {
          if (phase === 'selection') throw new Error('Attachment selection failed');
          if (phase === 'async selection') return Promise.reject(new Error('Async attachment selection failed'));
          return async () => {
            throw new Error('Attachment execution failed');
          };
        }) as AttachmentActionResolver,
      });
      const response = await upload();
      expect(response.status).toBe(500);
      expect(response.body.errors[0].message).toMatch(
        /(?:Attachment selection|Attachment execution|Async attachment selection) failed/,
      );
      expect(await records()).toBe(0);
      expect(await stored()).toEqual([]);
    },
  );
  it.each([null, false, {}, 'file', 'async undefined'])(
    'rejects invalid selection %j without storage effects',
    async (value) => {
      await register({
        attachmentResolver: (() =>
          value === 'async undefined' ? Promise.resolve(undefined) : value) as AttachmentActionResolver,
      });
      expect((await upload()).status).toBe(500);
      expect(await records()).toBe(0);
      expect(await stored()).toEqual([]);
    },
  );
  it.each([null, false, {}, 'file'])(
    'rejects invalid bootstrap resolver %j before any entry is registered',
    async (value) => {
      await expect(register({ attachmentResolver: value as AttachmentActionResolver })).rejects.toThrow(TypeError);
      expect(await stored()).toEqual([]);
    },
  );
  it('captures the resolver once at startup', async () => {
    const plugin = await register({ attachmentResolver: selected });
    plugin.options.attachmentResolver = () => undefined;
    expect((await upload()).body.data).toEqual({ selected: true, action: 'upload' });
    expect(await stored()).toEqual([]);
  });
  it('does not fall back when the selected executor returns no response', async () => {
    await register({ attachmentResolver: () => async () => {} });
    expect((await upload()).status).toBe(200);
    expect(await records()).toBe(0);
    expect(await stored()).toEqual([]);
  });
  it('preserves the existing file and metadata when selected deletion fails', async () => {
    await register({
      attachmentResolver: () => async () => {
        throw new Error('Selected deletion failed');
      },
    });
    const record = await seedFile();
    const response = await supertest(app.callback()).post(`/api/files:destroy?filterByTk=${record.get('id')}`);
    expect(response.status).toBe(500);
    expect(response.body.errors[0].message).toContain('Selected deletion failed');
    expect(await records()).toBe(1);
    expect(await fs.readFile(path.join(directory, 'retained.txt'))).toEqual(bytes);
  });
  it.each(['route', 'template'])('rejects a changed %s between selection and execution', async (change) => {
    await register({ attachmentResolver: selected });
    app.resourcer.use(
      async (ctx, next) => {
        if (change === 'route') Object.assign(ctx.action, { resourceName: 'documents', actionName: 'create' });
        else app.db.getCollection('files').options.template = 'general';
        await next();
      },
      { after: 'attachmentActionSelection', before: 'attachmentActionExecution' },
    );
    const response = await upload();
    expect(response.status).toBe(500);
    expect(response.body.errors[0].message).toContain('Selected attachment action identity changed');
    expect(await records()).toBe(0);
    expect(await stored()).toEqual([]);
  });
  it('fixes the file model before invoking the server selector', async () => {
    await register({
      attachmentResolver: (ctx) => {
        ctx.db.getCollection('files').model = ctx.db.getCollection('documents').model;
        return selected(ctx);
      },
    });
    const collection = app.db.getCollection('files');
    const model = collection.model;
    try {
      const response = await upload();
      expect(response.status).toBe(500);
      expect(response.body.errors[0].message).toContain('Selected attachment action identity changed');
      expect(await model.count()).toBe(0);
      expect(await stored()).toEqual([]);
    } finally {
      collection.model = model;
    }
  });
  it.each(['selection', 'execution'])('releases request state after the original %s failure', async (phase) => {
    await register();
    const failure = new Error('Original attachment failure');
    let fail = true;
    const entry = createAttachmentActionEntry(() => {
      if (fail && phase === 'selection') throw failure;
      return async (ctx) => {
        if (fail) throw failure;
        ctx.body = 'Retry after failure';
      };
    });
    app.resourcer.define({ name: 'files', actions: { upload: {} } });
    const action = app.resourcer.getAction('files', 'upload').clone();
    Object.assign(action, { resourceName: 'files', actionName: 'upload' });
    const ctx = { db: app.db, action, body: undefined as unknown } as Context;
    const execute = () =>
      entry.select(ctx, () =>
        entry.execute(ctx, async () => {
          throw new Error('Unexpected fallback');
        }),
      );
    await expect(execute()).rejects.toBe(failure);
    fail = false;
    await execute();
    expect(ctx.body).toBe('Retry after failure');
    expect(await records()).toBe(0);
    expect(await stored()).toEqual([]);
  });
  it('does not activate when a resolver is added after startup', async () => {
    const plugin = await register();
    plugin.options.attachmentResolver = selected;
    const response = await upload();
    expect(response.status).toBe(200);
    expect(await records()).toBe(1);
    expect(await fs.readFile(path.join(directory, response.body.data.filename))).toEqual(bytes);
  });
  it('leaves nonfile collections and other file actions in the original pipeline', async () => {
    await register({
      attachmentResolver: () => {
        throw new Error('Not a storage mutation');
      },
    });
    const record = await seedFile();
    const read = await supertest(app.callback()).get(`/api/files:get?filterByTk=${record.get('id')}`);
    expect(read.status).toBe(200);
    expect(read.body.data.title).toBe('Existing');
    const created = await supertest(app.callback()).post('/api/documents:create').send({ title: 'Ordinary record' });
    expect(created.status).toBe(200);
    expect(created.body.data.title).toBe('Ordinary record');
  });
  it('keeps concurrent selected and ordinary uploads isolated', async () => {
    await register({
      attachmentResolver: (ctx) =>
        ctx.action.params.marker === 'selected'
          ? async (selectedCtx) => {
              await Promise.resolve();
              selectedCtx.body = { selected: true };
            }
          : undefined,
    });
    const [selectedResponse, ordinaryResponse] = await Promise.all([upload('upload', 'selected'), upload()]);
    expect(selectedResponse.status).toBe(200);
    expect(selectedResponse.body.data).toEqual({ selected: true });
    expect(ordinaryResponse.status).toBe(200);
    expect(await fs.readFile(path.join(directory, ordinaryResponse.body.data.filename))).toEqual(bytes);
    expect(await records()).toBe(1);
    expect(await stored()).toHaveLength(1);
  });
  it('preserves the physical deletion stage with a late-registered auth middleware when not selected', async () => {
    await register();
    const record = await seedFile();
    const router = new Resourcer();
    // Exercise a separate real resource pipeline whose file extension registers before auth.
    initFileActions({
      app: { resourcer: router },
      options: { attachmentResolver: () => undefined },
    } as unknown as FilePlugin);
    let fileAtAuth = true;
    router.use(
      async (ctx, next) => {
        fileAtAuth = (await stored()).includes('retained.txt');
        ctx.state.currentRole = 'editor';
        ctx.state.currentUser = { id: 28 };
        await next();
      },
      { tag: 'auth' },
    );
    router.use(app.acl.middleware(), { tag: 'acl', after: 'auth' });
    router.define({
      name: 'files',
      actions: {
        destroy: async () => {
          await app.db.getRepository('files').destroy({ filterByTk: record.get('id') });
        },
      },
    });
    const action = router.getAction('files', 'destroy');
    Object.assign(action, { resourceName: 'files', actionName: 'destroy' });
    action.mergeParams({ filterByTk: record.get('id') });
    await router.execute(
      { resource: 'files', action: 'destroy' },
      {
        db: app.db,
        tego: app,
        state: {},
        logger: app.logger,
        get: () => '',
        throw: (status: number) => {
          throw new Error(String(status));
        },
      },
    );
    expect(fileAtAuth).toBe(false);
    expect(await records()).toBe(0);
    expect(await stored()).toEqual([]);
  });
});

import { ACL, Resourcer, type Collection, type Database } from '@tego/server';

import storageDefinition from '../../../../../module-file/src/server/collections/storages';
import { resolveStagedAttachmentStorage } from '../../../../../module-file/src/server/storages/storage-selection';
import * as attachments from '../../access-control/attachment-creation-entry';
import { sqliteDatabase } from './database';

describe('finalized source attachment field permission', () => {
  let db: Database;
  let source: Collection;
  let files: Collection;

  beforeEach(async () => {
    db = sqliteDatabase();
    db.collection(storageDefinition);
    files = db.collection({
      name: 'files',
      template: 'file',
      timestamps: false,
      fields: [{ name: 'storage', type: 'belongsTo', target: 'storages', foreignKey: 'storageId' }],
    });
    source = db.collection({
      name: 'documents',
      timestamps: false,
      fields: [
        { name: 'title', type: 'string' },
        { name: 'file', type: 'belongsTo', target: 'files', storage: 'receipts' },
        { name: 'files', type: 'belongsToMany', target: 'files', through: 'document_files', storage: 'receipts' },
        { name: 'wrong', type: 'belongsTo', target: 'storages' },
      ],
    });
    await db.sync();
    await db.getRepository('storages').create({
      values: [
        { name: 'default', type: 'local', default: true },
        { name: 'receipts', type: 'local' },
      ],
    });
  });
  afterEach(async () => {
    await db?.close();
  });

  async function context(operation = 'update', params: object = {}) {
    const acl = new ACL();
    acl.setAvailableAction(operation, {});
    acl.define({ role: 'editor' }).grantAction(`documents:${operation}`, params);
    const resourcer = new Resourcer();
    resourcer.define({ name: 'documents', actions: { [operation]: {} } });
    const action = resourcer.getAction('documents', operation).clone();
    Object.assign(action, { resourceName: 'documents', actionName: operation });
    action.mergeParams({ resourceName: 'documents', actionName: operation });
    const ctx = {
      db,
      action,
      state: { currentRole: 'editor', currentUser: { id: 28 } },
      permission: undefined as unknown,
      get: () => '+08:00',
      logger: { info() {} },
      throw(status: number) {
        throw new Error(String(status));
      },
    };
    await acl.middleware()(ctx as never, async () => {});
    return ctx;
  }

  it.each([
    ['create', 'file'],
    ['update', 'file'],
    ['create', 'files'],
    ['update', 'files'],
  ])('permits only the finalized %s field %s to select its actual configured storage', async (operation, name) => {
    const ctx = await context(operation, { whitelist: [name] });
    const captured = attachments.captureAttachmentFieldPermission(db, ctx, 'editor', source.getField(name), files);
    const selected = await resolveStagedAttachmentStorage(files, captured.field);
    captured.assertCurrent();
    expect(selected.values.name).toBe('receipts');
    expect(await source.model.count()).toBe(0);
    expect(await files.model.count()).toBe(0);
  });

  it.each([{ whitelist: [] }, { whitelist: ['title'] }, { blacklist: ['file'] }, { blacklist: ['fileId'] }])(
    'rejects a denied attachment field before selecting a storage: %j',
    async (params) => {
      const ctx = await context('update', params);
      expect(() =>
        attachments.captureAttachmentFieldPermission(db, ctx, 'editor', source.getField('file'), files),
      ).toThrow();
      expect(await files.model.count()).toBe(0);
    },
  );

  it('does not promote request field grants over the finalized source decision', async () => {
    const ctx = await context('update', { whitelist: ['title'] });
    ctx.action.mergeParams({ whitelist: ['file'] });
    expect(() =>
      attachments.captureAttachmentFieldPermission(db, ctx, 'editor', source.getField('file'), files),
    ).toThrow();
  });

  it.each(['title', 'wrong'])('rejects a field that is not an attachment relation: %s', async (name) => {
    const ctx = await context();
    expect(() =>
      attachments.captureAttachmentFieldPermission(db, ctx, 'editor', source.getField(name), files),
    ).toThrow();
  });

  it('rejects another source role and a denied source operation', async () => {
    const ctx = await context();
    expect(() =>
      attachments.captureAttachmentFieldPermission(db, ctx, 'other', source.getField('file'), files),
    ).toThrow();
    (ctx.permission as { can: unknown }).can = false;
    expect(() =>
      attachments.captureAttachmentFieldPermission(db, ctx, 'editor', source.getField('file'), files),
    ).toThrow();
  });

  it('rejects a read operation rather than treating visibility as a field-write grant', async () => {
    const ctx = await context('get');
    expect(() =>
      attachments.captureAttachmentFieldPermission(db, ctx, 'editor', source.getField('file'), files),
    ).toThrow();
  });

  it('rejects changed finalized field grants after an asynchronous selection', async () => {
    const ctx = await context('update', { whitelist: ['file'] });
    const captured = attachments.captureAttachmentFieldPermission(db, ctx, 'editor', source.getField('file'), files);
    await resolveStagedAttachmentStorage(files, captured.field);
    (ctx.permission as { parsedParams: { whitelist: string[] } }).parsedParams.whitelist.length = 0;
    expect(() => captured.assertCurrent()).toThrow();
  });

  it('rejects a replaced registered field after capture', async () => {
    const ctx = await context();
    const captured = attachments.captureAttachmentFieldPermission(db, ctx, 'editor', source.getField('file'), files);
    source.removeField('file');
    source.addField('file', { type: 'belongsTo', target: 'files', storage: 'receipts' });
    expect(() => captured.assertCurrent()).toThrow();
  });

  it('rejects another database even when table and field names match', async () => {
    const other = sqliteDatabase();
    try {
      const ctx = await context();
      expect(() =>
        attachments.captureAttachmentFieldPermission(other, ctx, 'editor', source.getField('file'), files),
      ).toThrow();
    } finally {
      await other.close();
    }
  });
});

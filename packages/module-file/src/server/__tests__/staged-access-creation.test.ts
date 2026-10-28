import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ACL, type Collection, type Database, type WhereOptions } from '@tego/server';

import { withStagedAttachmentTransaction } from '..';
import { seedAclScopes } from '../../../../module-tenant/src/server/__tests__/access-control/acl-database';
import {
  configStore,
  mainIdentity,
  seedConfigStore,
} from '../../../../module-tenant/src/server/__tests__/access-control/config-database';
import { sqliteDatabase } from '../../../../module-tenant/src/server/__tests__/access-control/database';
import { configFor, ownerCondition } from '../../../../module-tenant/src/server/__tests__/access-control/fixtures';
import { AccessAclScopeAdapter } from '../../../../module-tenant/src/server/access-control/acl-scope';
import { accessCollectionKey } from '../../../../module-tenant/src/server/access-control/config-store';
import { AccessCreationService } from '../../../../module-tenant/src/server/access-control/creation';
import { AccessQueryService } from '../../../../module-tenant/src/server/access-control/query';

describe('staged storage with the access-controlled creation service', () => {
  let db: Database;
  let docs: Collection;
  let directory: string;
  let adapter: AccessAclScopeAdapter;
  let service: AccessCreationService;
  let store: ReturnType<typeof configStore>;
  let destination: string;
  let stored: boolean;
  const ctx = {};
  const bytes = Buffer.from('Access-controlled attachment');

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tego-file-access-create-'));
    db = sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    docs = db.collection({
      name: 'documents',
      tableName: 'access_documents',
      template: 'file',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'tenantId', type: 'string', field: 'tenant_id' },
        { name: 'name', type: 'string' },
        { name: 'amount', type: 'integer' },
        { name: 'filename', type: 'string' },
        { name: 'title', type: 'string' },
        { name: 'extname', type: 'string' },
        { name: 'size', type: 'integer' },
        { name: 'mimetype', type: 'string' },
        { name: 'path', type: 'string' },
        { name: 'url', type: 'string' },
        { name: 'meta', type: 'json' },
      ],
    });
    db.collection({
      name: 'tenants',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'parentId', type: 'string' },
        { name: 'enabled', type: 'boolean' },
      ],
    });
    await db.sync();
    await db.getRepository('tenants').create({
      values: [
        { id: 'B', enabled: true },
        { id: 'C', enabled: true },
      ],
    });
    store = configStore(db);
    await store.save(mainIdentity, { ...configFor(ownerCondition), revision: 0 }, { userId: 28 });
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    const queries = new AccessQueryService(db, adapter, (collection) =>
      accessCollectionKey({
        ...mainIdentity,
        collectionName: collection.name,
        collectionKey: collection.name === 'documents' ? 'documents-key' : collection.name,
      }),
    );
    service = new AccessCreationService(db, adapter, queries);
    await adapter.prepare(ctx, [mainIdentity]);
    stored = false;
  });
  afterEach(async () => {
    adapter?.release(ctx);
    await db?.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function create(where?: WhereOptions, tenantId: string | undefined = 'B') {
    const staged = path.join(directory, 'staged');
    const root = path.join(directory, 'storage');
    await fs.writeFile(staged, bytes);
    return withStagedAttachmentTransaction(
      db,
      {
        id: 17,
        title: 'Local',
        type: 'local',
        name: 'local',
        path: '',
        baseUrl: '/files',
        options: { documentRoot: root },
      },
      { path: staged, originalname: 'receipt.pdf', mimetype: 'application/pdf', size: bytes.length },
      async ({ transaction, values, store: saveFile }) => {
        destination = path.join(root, values.filename);
        const { storageId: _storageId, ...physical } = values;
        return service.withCreatedRecordsInTransaction(
          ctx,
          mainIdentity,
          { tenantId },
          { values: [{ id: 100, name: 'draft', amount: 10, ...physical }], where },
          transaction,
          async (plan) => [await docs.repository.create({ values: plan.values[0], transaction: plan.transaction })],
          undefined,
          async () => {
            await saveFile();
            stored = true;
            expect(await fs.readFile(destination)).toEqual(bytes);
          },
        );
      },
    );
  }

  it('commits an actually authorized creation with current ownership and its actual bytes', async () => {
    expect(await create()).toEqual({ keys: [100], affected: 1 });
    expect(stored).toBe(true);
    expect((await docs.model.findByPk(100)).getDataValue('tenantId')).toBe('B');
    expect(await fs.readFile(destination)).toEqual(bytes);
  });
  it('rolls back both row and file when only V permits access to the newly created row', async () => {
    const previous = await store.read(mainIdentity);
    await store.save(
      mainIdentity,
      { ...configFor(ownerCondition, 'visibility'), revision: previous.revision },
      { userId: 28 },
    );
    adapter.release(ctx);
    await adapter.prepare(ctx, [mainIdentity]);
    await expect(create()).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(stored).toBe(true);
    expect(await docs.repository.count()).toBe(0);
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rolls back the stored file when a real insert hook transfers ownership to another tenant', async () => {
    db.on('documents.beforeCreate', (record) => record.setDataValue('tenantId', 'C'));
    await expect(create()).rejects.toMatchObject({ code: 'ACCESS_OWNERSHIP_CHANGE_FORBIDDEN' });
    expect(stored).toBe(true);
    expect(await docs.repository.count()).toBe(0);
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('keeps the caller role condition in final authorization and cleans the rejected file', async () => {
    await expect(create({ amount: 20 })).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(stored).toBe(true);
    expect(await docs.repository.count()).toBe(0);
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

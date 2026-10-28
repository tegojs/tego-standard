import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ACL, Resourcer, Transaction, type Collection, type Database, type WhereOptions } from '@tego/server';

import {
  captureStagedAttachmentRecord,
  resolveStagedAttachmentStorage,
  withStagedAttachmentTransaction,
  type StagedAttachmentStorage,
} from '..';
import { seedAclScopes } from '../../../../module-tenant/src/server/__tests__/access-control/acl-database';
import {
  configStore,
  mainIdentity,
  seedConfigStore,
} from '../../../../module-tenant/src/server/__tests__/access-control/config-database';
import {
  isolatedPostgresDatabase,
  sqliteDatabase,
} from '../../../../module-tenant/src/server/__tests__/access-control/database';
import { configFor, ownerCondition } from '../../../../module-tenant/src/server/__tests__/access-control/fixtures';
import { AccessAclScopeAdapter } from '../../../../module-tenant/src/server/access-control/acl-scope';
import { accessCollectionKey } from '../../../../module-tenant/src/server/access-control/config-store';
import { AccessCreationService } from '../../../../module-tenant/src/server/access-control/creation';
import { AccessQueryService } from '../../../../module-tenant/src/server/access-control/query';
import { AccessRootMutationHandler } from '../../../../module-tenant/src/server/access-control/root-mutation-handler';
import storages from '../collections/storages';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

// Proves G, INSERT receipts, storage selection and bytes, not finalized HTTP operation/field ACL.
describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])(
  'dedicated staged attachment creation (%s)',
  (dialect) => {
    let db: Database;
    let docs: Collection;
    let adapter: AccessAclScopeAdapter;
    let service: AccessCreationService;
    let handler: AccessRootMutationHandler;
    const entryContexts: object[] = [];
    let configs: ReturnType<typeof configStore>;
    let directory: string;
    let destination: string;
    let stored: boolean;
    const ctx = {};
    const bytes = Buffer.from('Actual selected storage and ownership');

    beforeEach(async () => {
      directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tego-file-storage-create-'));
      db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl) : sqliteDatabase();
      await seedConfigStore(db);
      await seedAclScopes(db);
      db.collection(storages);
      docs = db.collection({
        name: 'documents',
        tableName: 'access_documents',
        template: 'file',
        timestamps: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true, autoIncrement: true },
          { name: 'tenantId', type: 'string', field: 'tenant_id' },
          { name: 'name', type: 'string' },
          { name: 'amount', type: 'integer' },
          ...['filename', 'title', 'extname', 'path', 'url', 'mimetype'].map((name) => ({ name, type: 'string' })),
          { name: 'size', type: 'integer' },
          { name: 'meta', type: 'json' },
          { name: 'storage', type: 'belongsTo', target: 'storages', foreignKey: 'storageId' },
        ],
      });
      db.collection({
        name: 'tenants',
        timestamps: false,
        autoGenId: false,
        fields: [
          { name: 'id', type: 'string', primaryKey: true },
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
      await db.getRepository('storages').create({
        values: [
          {
            id: 17,
            name: 'local',
            type: 'local',
            title: 'Local',
            default: true,
            baseUrl: '/files',
            options: { documentRoot: path.join(directory, 'root') },
          },
          { id: 18, name: 'other', type: 'local', title: 'Other', default: false },
        ],
      });
      configs = configStore(db);
      await configs.save(mainIdentity, { ...configFor(ownerCondition), revision: 0 }, { userId: 28 });
      adapter = new AccessAclScopeAdapter(new ACL(), 'main', configs, db);
      const queries = new AccessQueryService(db, adapter, (collection) =>
        accessCollectionKey({
          ...mainIdentity,
          collectionName: collection.name,
          collectionKey: collection.name === 'documents' ? 'documents-key' : collection.name,
        }),
      );
      service = new AccessCreationService(db, adapter, queries);
      handler = new AccessRootMutationHandler(db, adapter, queries, (collection) =>
        collection === docs
          ? mainIdentity
          : { ...mainIdentity, collectionKey: collection.name, collectionName: collection.name },
      );
      await adapter.prepare(ctx, [mainIdentity]);
      stored = false;
    });
    afterEach(async () => {
      adapter?.release(ctx);
      for (const entry of entryContexts.splice(0)) adapter?.release(entry);
      try {
        if (dialect === 'postgres')
          await db.sequelize.query(
            'DROP TABLE IF EXISTS "rolesResourcesScopesActions", "dataSourcesRolesResourcesScopesActions", ' +
              '"rolesResourcesScopes", "dataSourcesRolesResourcesScopes", ' +
              '"access_config_collections", "access_config_dataSourcesCollections", "tenantAccessRevisions", ' +
              '"access_documents", "tenants", "storages"',
          );
      } finally {
        await db?.close();
        await fs.rm(directory, { recursive: true, force: true });
      }
    });

    async function create(
      options: {
        where?: WhereOptions;
        input?: Record<string, unknown>;
        afterStore?: (transaction: Transaction) => Promise<void>;
        entry?: ReturnType<AccessRootMutationHandler['captureAttachment']>;
      } = {},
    ) {
      const staged = path.join(directory, 'staged');
      await fs.writeFile(staged, bytes);
      const selected = await resolveStagedAttachmentStorage(docs);
      return withStagedAttachmentTransaction(
        db,
        selected.values as unknown as StagedAttachmentStorage,
        { path: staged, originalname: 'receipt.pdf', mimetype: 'application/pdf', size: bytes.length },
        async ({ transaction, values, store }) => {
          const { storageId, ...metadata } = values;
          const verify = captureStagedAttachmentRecord(docs, values);
          destination = path.join(directory, 'root', values.path, values.filename);
          const persist = async () => {
            await store();
            stored = true;
            expect(await fs.readFile(destination)).toEqual(bytes);
            await options.afterStore?.(transaction);
          };
          if (options.entry)
            return options.entry.create({
              transaction,
              storage: { key: storageId, assertCurrent: selected.assertCurrent },
              metadata: values,
              afterPersist: persist,
              verifyRecord: verify,
            });
          const result = await service.withCreatedAttachmentInTransaction(
            ctx,
            mainIdentity,
            { tenantId: 'B' },
            { values: [{ id: 100, name: 'draft', amount: 10, ...metadata, ...options.input }], where: options.where },
            transaction,
            { key: storageId, assertCurrent: selected.assertCurrent },
            async (plan) => [await docs.repository.create({ values: plan.values[0], transaction: plan.transaction })],
            undefined,
            persist,
          );
          await verify(result.keys[0], transaction);
          return result;
        },
      );
    }

    async function entry(operation: 'create' | 'upload' = 'upload', values: object = {}, grants: object = {}) {
      const acl = new ACL();
      acl.setAvailableAction('create', { type: 'new-data' });
      acl.setAvailableAction('upload', { type: 'new-data' });
      acl.define({ role: 'uploader' }).grantAction('documents:' + operation, grants);
      const resourcer = new Resourcer();
      resourcer.define({ name: 'documents', actions: { create: {}, upload: {} } });
      const action = resourcer.getAction('documents', operation).clone();
      Object.assign(action, {
        resourceName: 'documents',
        actionName: operation,
        sourceId: undefined,
        resourceOf: undefined,
      });
      action.mergeParams({ resourceName: 'documents', actionName: operation, values });
      const context = {
        db,
        action,
        permission: undefined as unknown,
        state: { currentRole: 'uploader', currentUser: { id: 28 } },
        get: () => '+08:00',
        logger: { info: () => {} },
        throw: (status: number) => {
          throw new Error(String(status));
        },
      };
      entryContexts.push(context);
      await adapter.prepare(context, [mainIdentity]);
      await acl.middleware()(context as never, async () => {});
      return {
        context,
        capture: () => handler.captureAttachment(context, { tenantId: 'B', roleName: 'uploader', userId: 28 }),
      };
    }

    it.skipIf(dialect !== 'sqlite')(
      'rejects the storage relationship on the unvalidated SQLite write dialect',
      async () => {
        await expect(create()).rejects.toMatchObject({ code: 'UNSUPPORTED_ACCESS_MUTATION' });
        expect(stored).toBe(false);
        expect(await docs.repository.count()).toBe(0);
      },
    );

    it('keeps ordinary creation from assigning the managed storage foreign key', async () => {
      await expect(
        service.withCreatedRecords(
          ctx,
          mainIdentity,
          { tenantId: 'B' },
          { values: [{ id: 100, storageId: 17 }] },
          async (plan) => [await docs.repository.create({ values: plan.values[0], transaction: plan.transaction })],
        ),
      ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(await docs.repository.count()).toBe(0);
    });

    describe.skipIf(dialect !== 'postgres')('same-transaction PostgreSQL composition', () => {
      it.each(['create', 'upload'] as const)(
        'uses actual finalized %s field permission with G and real storage bytes',
        async (operation) => {
          const selected = await entry(operation, { title: 'Approved title', amount: 999 }, { fields: ['title'] });
          expect(await create({ entry: selected.capture() })).toEqual({ keys: [1], affected: 1 });
          const row = await docs.repository.findOne();
          expect(row.get('title')).toBe('Approved title');
          expect(row.get('amount')).toBeNull();
          expect(row.get('tenantId')).toBe('B');
          expect(row.get('storageId')).toBe(17);
          expect(await fs.readFile(destination)).toEqual(bytes);
        },
      );
      it('preserves the finalized upload role filter and rolls back actual bytes on rejection', async () => {
        const selected = await entry('upload', {}, { filter: { amount: 20 } });
        await expect(create({ entry: selected.capture() })).rejects.toMatchObject({
          code: 'ACCESS_RECORD_UNAVAILABLE',
        });
        expect(stored).toBe(true);
        expect(await docs.repository.count()).toBe(0);
        await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
      });
      it('rejects borrowing create permission for upload before parsing or writing a file', async () => {
        const selected = await entry();
        Object.assign(selected.context.permission as object, { actionName: 'create' });
        expect(selected.capture).toThrowError(expect.objectContaining({ code: 'INVALID_ACCESS_MUTATION' }));
        expect(stored).toBe(false);
        expect(await docs.repository.count()).toBe(0);
      });
      it('rejects client-controlled managed storage input even outside the allowed field list', async () => {
        const selected = await entry('upload', { storageId: 18 }, { fields: ['title'] });
        expect(selected.capture).toThrowError(expect.objectContaining({ code: 'INVALID_ACCESS_MUTATION' }));
        expect(stored).toBe(false);
        expect(await docs.repository.count()).toBe(0);
      });
      it('rejects an explicitly denied final decision without borrowing its parsed parameters', async () => {
        const selected = await entry();
        Object.assign(selected.context.permission as object, { can: false, skip: false });
        expect(selected.capture).toThrowError(expect.objectContaining({ code: 'INVALID_ACCESS_MUTATION' }));
        expect(await docs.repository.count()).toBe(0);
      });
      it('cannot reuse a consumed upload entry for a second attachment', async () => {
        const selected = await entry();
        const captured = selected.capture();
        await create({ entry: captured });
        await expect(create({ entry: captured })).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
        expect(await docs.repository.count()).toBe(1);
        expect(await fs.readdir(path.join(directory, 'root'))).toHaveLength(1);
      });
      it('keeps captured request values and final field grants independent of later request mutation', async () => {
        const selected = await entry('upload', { title: 'Approved title' }, { fields: ['title'] });
        const captured = selected.capture();
        const permission = selected.context.permission as {
          rawParams: { values: { title: string } };
          parsedParams: object;
        };
        permission.rawParams.values.title = 'Injected title';
        Object.assign(permission.parsedParams, { blacklist: ['title'], filter: { amount: 999 } });
        await create({ entry: captured });
        expect((await docs.repository.findOne()).get('title')).toBe('Approved title');
      });
      it('rolls back actual bytes when the prepared entry expires after storage', async () => {
        const selected = await entry();
        await expect(
          create({ entry: selected.capture(), afterStore: async () => adapter.release(selected.context) }),
        ).rejects.toMatchObject({ code: 'INVALID_ACCESS_CONFIG_WRITE' });
        expect(stored).toBe(true);
        expect(await docs.repository.count()).toBe(0);
        await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
      });
      it('rejects unadapted attachment-field storage overrides rather than using a different default', async () => {
        const selected = await entry();
        (selected.context.permission as { rawParams: Record<string, unknown> }).rawParams.attachmentField =
          'contracts.files';
        expect(selected.capture).toThrowError(expect.objectContaining({ code: 'INVALID_ACCESS_MUTATION' }));
        expect(await docs.repository.count()).toBe(0);
      });
      it('rejects non-enumerable raw-value accessors without executing them', async () => {
        const selected = await entry();
        Object.defineProperty((selected.context.permission as { rawParams: object }).rawParams, 'values', {
          enumerable: false,
          get() {
            throw new Error('Getter executed');
          },
        });
        expect(selected.capture).toThrowError(expect.objectContaining({ code: 'INVALID_ACCESS_MUTATION' }));
        expect(await docs.repository.count()).toBe(0);
      });
      it('does not degrade to ordinary creation when the trusted storage selection is absent', async () => {
        await expect(
          db.sequelize.transaction(
            { type: Transaction.TYPES.IMMEDIATE, isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE },
            (transaction) =>
              service.withCreatedAttachmentInTransaction(
                ctx,
                mainIdentity,
                { tenantId: 'B' },
                { values: [{ id: 100, amount: 10 }] },
                transaction,
                undefined,
                async (plan) => [
                  await docs.repository.create({ values: plan.values[0], transaction: plan.transaction }),
                ],
              ),
          ),
        ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
        expect(await docs.repository.count()).toBe(0);
      });
      it('commits a real INSERT with current ownership, server-selected storage and actual bytes', async () => {
        expect(await create()).toEqual({ keys: [100], affected: 1 });
        const row = await docs.repository.findOne({ filterByTk: 100, appends: ['storage'] });
        expect(row.getDataValue('tenantId')).toBe('B');
        expect(row.get('storage').get('id')).toBe(17);
        expect(await fs.readFile(destination)).toEqual(bytes);
      });
      it('rejects client storage values even on the dedicated method', async () => {
        await expect(create({ input: { storageId: 18 } })).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
        expect(stored).toBe(false);
        expect(await docs.repository.count()).toBe(0);
      });
      it('does not permit new records based on visibility alone', async () => {
        const previous = await configs.read(mainIdentity);
        await configs.save(
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
      it('preserves the independently resolved caller role condition', async () => {
        await expect(create({ where: { amount: 20 } })).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
        expect(stored).toBe(true);
        expect(await docs.repository.count()).toBe(0);
        await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
      });
      it('rolls back bytes and the row when a real hook changes storageId', async () => {
        db.on('documents.beforeCreate', (row) => row.setDataValue('storageId', 18));
        await expect(create()).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
        expect(stored).toBe(true);
        expect(await docs.repository.count()).toBe(0);
        await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
      });
      it('rolls back bytes and the row when a hook changes ownership', async () => {
        db.on('documents.beforeCreate', (row) => row.setDataValue('tenantId', 'C'));
        await expect(create()).rejects.toMatchObject({ code: 'ACCESS_OWNERSHIP_CHANGE_FORBIDDEN' });
        expect(stored).toBe(true);
        expect(await docs.repository.count()).toBe(0);
        await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
      });
      it('rechecks selected server storage after copying the actual file', async () => {
        await expect(
          create({
            afterStore: (transaction) =>
              db
                .getRepository('storages')
                .update({ filterByTk: 17, values: { path: 'changed' }, transaction })
                .then(() => undefined),
          }),
        ).rejects.toThrow('Selected attachment storage changed');
        expect(stored).toBe(true);
        expect(await docs.repository.count()).toBe(0);
        expect((await db.getRepository('storages').findOne({ filterByTk: 17 })).get('path')).toBe('');
        await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
      });
      it('rejects storage changed by an INSERT hook before copying any bytes', async () => {
        db.on('documents.afterCreate', async (_row, options) => {
          await db
            .getRepository('storages')
            .update({ filterByTk: 17, values: { path: 'changed' }, transaction: options.transaction });
        });
        await expect(create()).rejects.toThrow('Selected attachment storage changed');
        expect(stored).toBe(false);
        expect(await docs.repository.count()).toBe(0);
        await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
      });
      it('rejects a second relationship sharing storageId', async () => {
        docs.setField('alternateStorage', { type: 'belongsTo', target: 'storages', foreignKey: 'storageId' });
        await expect(create()).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
        expect(stored).toBe(false);
        expect(await docs.repository.count()).toBe(0);
      });
    });
  },
);

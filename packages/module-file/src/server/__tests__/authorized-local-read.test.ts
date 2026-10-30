import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createServer, get, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ACL, Resourcer, Transaction, type Collection, type Database } from '@tego/server';

import * as files from '..';
import { seedAclScopes } from '../../../../module-tenant/src/server/__tests__/access-control/acl-database';
import {
  mainIdentity,
  seedConfigStore,
} from '../../../../module-tenant/src/server/__tests__/access-control/config-database';
import {
  isolatedPostgresDatabase,
  sqliteDatabase,
} from '../../../../module-tenant/src/server/__tests__/access-control/database';
import { configFor, ownerCondition } from '../../../../module-tenant/src/server/__tests__/access-control/fixtures';
import { AccessAclScopeAdapter } from '../../../../module-tenant/src/server/access-control/acl-scope';
import {
  accessCollectionKey,
  AccessConfigStore,
} from '../../../../module-tenant/src/server/access-control/config-store';
import { resolveModelMetadata } from '../../../../module-tenant/src/server/access-control/model-metadata';
import { AccessQueryService } from '../../../../module-tenant/src/server/access-control/query';
import { AccessRootMutationHandler } from '../../../../module-tenant/src/server/access-control/root-mutation-handler';
import { AccessRootReadHandler } from '../../../../module-tenant/src/server/access-control/root-read-handler';
import storageDefinition from '../collections/storages';
import { createRemovalCommitProxy } from './fixtures/removal-commit-proxy';
import { openOwnedReadOnlyRemovalFixture } from './fixtures/removal-owned-read-only';
import { openReadOnlyRemovalFixtureSession } from './fixtures/removal-session-client';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const fields = ['id', 'path', 'filename', 'size', 'storageId'];
const bytes = Buffer.from('Actual private headquarters attachment');

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])(
  'authorized local attachment content (%s)',
  (dialect) => {
    let db: Database;
    let docs: Collection;
    let adapter: AccessAclScopeAdapter;
    let handler: AccessRootReadHandler;
    let mutations: AccessRootMutationHandler;
    let directory: string;
    let root: string;
    let rendered: boolean;
    let testPostgresUrl = postgresUrl;
    const location = () => path.join(root, 'old/tenants/H', 'receipt.txt');
    const identity = (collection: Collection) =>
      collection.name === 'documents'
        ? mainIdentity
        : { ...mainIdentity, collectionName: collection.name, collectionKey: `${collection.name}-key` };

    beforeEach(async () => {
      rendered = false;
      directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tego-authorized-local-read-'));
      root = path.join(directory, 'root');
      await fs.mkdir(path.dirname(location()), { recursive: true });
      await fs.writeFile(location(), bytes);
      db = dialect === 'postgres' ? isolatedPostgresDatabase(testPostgresUrl!) : sqliteDatabase();
      await seedConfigStore(db);
      await seedAclScopes(db);
      db.collection(storageDefinition);
      docs = db.collection({
        name: 'documents',
        ...(dialect === 'postgres' ? { schema: 'public' } : {}),
        template: 'file',
        timestamps: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true },
          ...['tenantId', 'path', 'filename'].map((name) => ({ name, type: 'string' })),
          { name: 'size', type: 'integer' },
          { name: 'viewable', type: 'boolean' },
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
      await db.getCollection('tenants').model.bulkCreate(['H', 'B'].map((id) => ({ id, enabled: true })));
      await db.getRepository('storages').create({
        values: {
          id: 18,
          name: 'private',
          type: 'local',
          title: 'Private',
          path: 'new-upload-path',
          baseUrl: 'https://never-fetch.invalid',
          options: { documentRoot: root },
        },
      });
      await docs.model.bulkCreate([
        {
          id: 1,
          tenantId: 'B',
          viewable: false,
          path: 'old/tenants/H',
          filename: 'receipt.txt',
          size: bytes.length,
          storageId: 18,
        },
        {
          id: 2,
          tenantId: 'H',
          viewable: true,
          path: 'old/tenants/H',
          filename: 'receipt.txt',
          size: bytes.length,
          storageId: 18,
        },
        {
          id: 3,
          tenantId: 'H',
          viewable: false,
          path: 'old/tenants/H',
          filename: 'receipt.txt',
          size: bytes.length,
          storageId: 18,
        },
      ]);
      const store = new AccessConfigStore(db, (value) =>
        resolveModelMetadata(db.getCollection(value.collectionName), {
          resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
        }),
      );
      const config = configFor(ownerCondition);
      config.rules.push({
        ...configFor(
          {
            type: 'compare',
            operator: 'eq',
            left: { type: 'field', path: 'viewable' },
            right: { type: 'literal', value: true },
          },
          'visibility',
        ).rules[0],
        id: 'visible',
      });
      await store.save(mainIdentity, { ...config, revision: 0 }, { userId: 28 });
      adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
      handler = new AccessRootReadHandler(
        db,
        adapter,
        new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection))),
        identity,
      );
      mutations = new AccessRootMutationHandler(
        db,
        adapter,
        new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection))),
        identity,
      );
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      try {
        if (dialect === 'postgres') await db.sequelize.drop({ cascade: true });
      } finally {
        await db?.close();
        if (directory) await fs.rm(directory, { recursive: true, force: true });
      }
    });

    async function context(key = 2, grant: object = { fields }, operation = 'download') {
      const acl = new ACL();
      acl.setAvailableAction(operation, {});
      acl.define({ role: 'reader' }).grantAction(`documents:${operation}`, grant);
      const resourcer = new Resourcer();
      resourcer.define({ name: 'documents', actions: { [operation]: {} } });
      const action = resourcer.getAction('documents', operation).clone();
      Object.assign(action, { resourceName: 'documents', actionName: operation });
      action.mergeParams({ resourceName: 'documents', actionName: operation, filterByTk: key });
      const ctx = {
        db,
        action,
        state: { currentRole: 'reader' },
        get: () => '+08:00',
        logger: { info() {} },
        throw(status: number) {
          throw new Error(String(status));
        },
        permission: undefined as unknown,
      };
      await acl.middleware()(ctx as never, async () => {});
      await adapter.prepare(ctx, [mainIdentity]);
      return ctx;
    }

    async function read<T>(
      ctx: Awaited<ReturnType<typeof context>>,
      consume: (handle: FileHandle) => Promise<T>,
      render = (raw: Record<string, unknown>) => {
        rendered = true;
        return raw;
      },
    ) {
      return await files.withAuthorizedLocalAttachmentRead(
        handler.captureAttachment(ctx, { tenantId: 'B', roleName: 'reader', userId: 28 }),
        render,
        consume,
      );
    }

    describe('authorized removal storage preparation', () => {
      async function prepare<T>(
        ctx: Awaited<ReturnType<typeof context>>,
        consume: Parameters<typeof files.withAuthorizedAttachmentRemovalStorage<T>>[2],
      ) {
        const entry = mutations.captureAttachmentRemoval(ctx, { tenantId: 'B', roleName: 'reader', userId: 28 });
        return db.sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE }, (transaction) =>
          files.withAuthorizedAttachmentRemovalStorage(entry, transaction, consume),
        );
      }

      describe('existing local removal object identity', () => {
        it('captures actual file and directory identities from the original storage without changing bytes or rows', async () => {
          const object = await fs.lstat(location(), { bigint: true });
          const receipt = await prepare(await context(1, {}, 'destroy'), files.captureLocalAttachmentRemovalObject);
          expect(receipt).toMatchObject({
            schemaVersion: 1,
            kind: 'attachment-removal-local-object',
            configuredRoot: root,
            root: await fs.realpath(root),
            record: { key: 1, storageId: 18, path: 'old/tenants/H', filename: 'receipt.txt', size: bytes.length },
            object: {
              dev: String(object.dev),
              ino: String(object.ino),
              birthtimeNs: String(object.birthtimeNs),
              mtimeNs: String(object.mtimeNs),
              ctimeNs: String(object.ctimeNs),
              size: String(bytes.length),
            },
          });
          expect(receipt.directories.map((directory) => directory.path)).toEqual([
            '',
            'old',
            'old/tenants',
            'old/tenants/H',
          ]);
          for (const directory of receipt.directories) {
            const actual = await fs.lstat(path.join(root, directory.path), { bigint: true });
            expect(directory).toMatchObject({
              dev: String(actual.dev),
              ino: String(actual.ino),
              birthtimeNs: String(actual.birthtimeNs),
            });
            expect(Object.isFrozen(directory)).toBe(true);
          }
          expect(Object.isFrozen(receipt)).toBe(true);
          expect(Object.isFrozen(receipt.object)).toBe(true);
          expect(Object.isFrozen(receipt.record)).toBe(true);
          expect(Object.isFrozen(receipt.directories)).toBe(true);
          expect(JSON.parse(JSON.stringify(receipt))).toEqual(receipt);
          expect(await docs.model.count()).toBe(3);
          expect(await fs.readFile(location())).toEqual(bytes);
        });

        it('retains the same captured object for a storage that requires retention', async () => {
          await db.getRepository('storages').update({ filterByTk: 18, values: { paranoid: true } });
          const receipt = await prepare(await context(1, {}, 'destroy'), files.captureLocalAttachmentRemovalObject);
          expect(receipt.kind).toBe('attachment-removal-local-object');
          expect(await fs.readFile(location())).toEqual(bytes);
          expect(await docs.model.count()).toBe(3);
        });

        it('does not accept a missing existing file as newly owned removal evidence', async () => {
          await fs.unlink(location());
          await expect(
            prepare(await context(1, {}, 'destroy'), (proof) => files.captureLocalAttachmentRemovalObject(proof)),
          ).rejects.toMatchObject({ code: 'ENOENT' });
          expect(await docs.model.count()).toBe(3);
        });

        it('refuses an object with another hard link rather than calling it exclusive content', async () => {
          await fs.link(location(), path.join(root, 'alias.txt'));
          await expect(
            prepare(await context(1, {}, 'destroy'), (proof) => files.captureLocalAttachmentRemovalObject(proof)),
          ).rejects.toThrow('Local attachment is not a matching regular file');
          expect(await fs.readFile(location())).toEqual(bytes);
          expect(await fs.readFile(path.join(root, 'alias.txt'))).toEqual(bytes);
        });

        it('rejects changed final destroy authorization during filesystem waits before returning evidence', async () => {
          const ctx = await context(1, {}, 'destroy');
          const original = fs.lstat;
          await expect(
            prepare(ctx, async (proof) => {
              vi.spyOn(fs, 'lstat').mockImplementationOnce(async (...args) => {
                const result = await original(...args);
                Object.assign(ctx.permission as object, { can: false, skip: false });
                return result;
              });
              await expect(files.captureLocalAttachmentRemovalObject(proof)).rejects.toThrow();
              throw new Error('rollback rejected identity capture');
            }),
          ).rejects.toThrow('rollback rejected identity capture');
          expect(await docs.model.count()).toBe(3);
          expect(await fs.readFile(location())).toEqual(bytes);
        });
      });

      describe.skipIf(dialect !== 'postgres')('transactional removal intents', () => {
        let intents: Collection;
        let journal: InstanceType<typeof files.AttachmentRemovalIntentJournal>;

        beforeEach(async () => {
          journal = undefined;
          intents = db.collection({
            name: 'attachment_removal_intents',
            autoGenId: false,
            timestamps: false,
            fields: [
              { name: 'id', type: 'string', primaryKey: true },
              { name: 'payload', type: 'jsonb' },
            ],
          });
          await intents.model.sync();
        });

        afterEach(async () => {
          await db.sequelize.query('DROP FUNCTION IF EXISTS tamper_removal_intent() CASCADE');
        });

        const persist = (proof: files.AuthorizedAttachmentRemovalPreparation) => {
          journal ??= new files.AttachmentRemovalIntentJournal(intents);
          return journal.persist(proof);
        };

        describe('bound local removal object evidence', () => {
          let objects: Collection;

          beforeEach(async () => {
            objects = db.collection({
              name: 'attachment_removal_objects',
              autoGenId: false,
              timestamps: false,
              fields: [
                { name: 'id', type: 'string', primaryKey: true },
                { name: 'payload', type: 'jsonb' },
              ],
            });
            await objects.model.sync();
          });

          afterEach(async () => {
            await db.sequelize.query('DROP FUNCTION IF EXISTS tamper_removal_object(jsonb) CASCADE');
          });

          it('stores actual object identity with the original UUID, transaction and complete physical intent', async () => {
            const stat = await fs.lstat(location(), { bigint: true });
            const handle = await prepare(await context(1, {}, 'destroy'), async (proof) => {
              const handle = await persist(proof);
              await journal.persistLocalObject(handle, proof, objects);
              await journal.assertLocalObjectMatches(handle, proof.transaction);
              const other = isolatedPostgresDatabase(postgresUrl!);
              try {
                const [rows] = await other.sequelize.query('SELECT id FROM attachment_removal_objects');
                expect(rows).toHaveLength(0);
              } finally {
                await other.close();
              }
              return handle;
            });
            const intent = (await intents.model.findByPk(handle.id)).getDataValue('payload');
            const [physical] = await db.sequelize
              .query(`SELECT 'attachment_removal_intents'::regclass::oid::text AS oid,
              'attachment_removal_objects'::regclass::oid::text AS object_oid`);
            const row = await objects.model.findByPk(handle.id);
            expect(row.getDataValue('payload')).toEqual({
              schemaVersion: 1,
              kind: 'attachment-removal-bound-local-object',
              journal: {
                oid: physical[0].object_oid,
                schema: 'public',
                tableName: 'attachment_removal_objects',
                primaryField: 'id',
                payloadField: 'payload',
              },
              intent: {
                id: handle.id,
                payload: intent,
                journal: {
                  oid: physical[0].oid,
                  schema: 'public',
                  tableName: 'attachment_removal_intents',
                  primaryField: 'id',
                  payloadField: 'payload',
                },
              },
              object: expect.objectContaining({
                schemaVersion: 1,
                kind: 'attachment-removal-local-object',
                configuredRoot: root,
                root: await fs.realpath(root),
                record: { key: 1, path: 'old/tenants/H', filename: 'receipt.txt', storageId: 18, size: bytes.length },
                object: {
                  dev: String(stat.dev),
                  ino: String(stat.ino),
                  birthtimeNs: String(stat.birthtimeNs),
                  mtimeNs: String(stat.mtimeNs),
                  ctimeNs: String(stat.ctimeNs),
                  size: String(bytes.length),
                },
              }),
            });
            expect(intent.schemaVersion).toBe(2);
            expect(intent.state).toBe('prepared');
            expect(intent.transactionId).toMatch(/^\d+$/);
            expect(intent.source).toMatchObject({ schema: 'public', tableName: 'documents', primaryField: 'id' });
            expect(intent.record.tenantId).toBe('B');
            expect(await docs.model.count()).toBe(3);
            expect(await fs.readFile(location())).toEqual(bytes);
          });

          it('rolls object evidence back with its original intent and caller transaction', async () => {
            await expect(
              prepare(await context(1, {}, 'destroy'), async (proof) => {
                const handle = await persist(proof);
                await journal.persistLocalObject(handle, proof, objects);
                throw new Error('rollback bound object');
              }),
            ).rejects.toThrow('rollback bound object');
            expect(await objects.model.count()).toBe(0);
            expect(await intents.model.count()).toBe(0);
            expect(await fs.readFile(location())).toEqual(bytes);
          });

          it('rejects copied handles and reconstructed preparations even with identical values', async () => {
            await prepare(await context(1, {}, 'destroy'), async (proof) => {
              const handle = await persist(proof);
              await expect(journal.persistLocalObject({ ...handle }, proof, objects)).rejects.toThrow(
                'Original removal intent handle is unavailable',
              );
              await expect(journal.persistLocalObject(handle, { ...proof }, objects)).rejects.toThrow(
                'Original removal object preparation is unavailable',
              );
              expect(await objects.model.count({ transaction: proof.transaction })).toBe(0);
            });
          });

          it('does not rebind an old handle to another active transaction or preparation', async () => {
            const old = await prepare(await context(1, {}, 'destroy'), persist);
            await prepare(await context(1, {}, 'destroy'), async (proof) => {
              await expect(journal.persistLocalObject(old, proof, objects)).rejects.toThrow(
                'Original removal intent transaction is unavailable',
              );
            });
            expect(await objects.model.count()).toBe(0);
          });

          it('refuses a changed persisted intent before binding filesystem evidence', async () => {
            await expect(
              prepare(await context(1, {}, 'destroy'), async (proof) => {
                const handle = await persist(proof);
                await intents.model.update(
                  { payload: { state: 'prepared' } },
                  { where: { id: handle.id }, transaction: proof.transaction },
                );
                await journal.persistLocalObject(handle, proof, objects);
              }),
            ).rejects.toThrow('Removal intent no longer matches its original preparation');
            expect(await objects.model.count()).toBe(0);
            expect(await intents.model.count()).toBe(0);
          });

          it('refuses to use the intent table as the independent object evidence table', async () => {
            await expect(
              prepare(await context(1, {}, 'destroy'), async (proof) => {
                const handle = await persist(proof);
                await journal.persistLocalObject(handle, proof, intents);
              }),
            ).rejects.toThrow('Removal object evidence requires independent physical tables');
            expect(await intents.model.count()).toBe(0);
          });

          it('keeps object evidence one-shot rather than silently replacing the recorded object', async () => {
            await prepare(await context(1, {}, 'destroy'), async (proof) => {
              const handle = await persist(proof);
              await journal.persistLocalObject(handle, proof, objects);
              await expect(journal.persistLocalObject(handle, proof, objects)).rejects.toThrow(
                'Removal object evidence already exists for this intent',
              );
              await journal.assertLocalObjectMatches(handle, proof.transaction);
            });
            expect(await objects.model.count()).toBe(1);
          });

          it.each(['object', 'source', 'transaction', 'intent', 'missing'])(
            'detects actual evidence drift: %s',
            async (kind) => {
              await expect(
                prepare(await context(1, {}, 'destroy'), async (proof) => {
                  const handle = await persist(proof);
                  await journal.persistLocalObject(handle, proof, objects);
                  const row = await objects.model.findByPk(handle.id, { transaction: proof.transaction });
                  const payload = structuredClone(row.getDataValue('payload'));
                  if (kind === 'object') payload.object.object.ino = '999999999999999999999';
                  if (kind === 'source') payload.intent.payload.source.oid = '1';
                  if (kind === 'transaction') payload.intent.payload.transactionId = '1';
                  if (kind === 'intent') payload.intent.id = '00000000-0000-4000-8000-000000000000';
                  if (kind === 'missing')
                    await objects.model.destroy({ where: { id: handle.id }, transaction: proof.transaction });
                  else await row.update({ payload }, { transaction: proof.transaction });
                  await journal.assertLocalObjectMatches(handle, proof.transaction);
                }),
              ).rejects.toThrow('Removal object evidence no longer matches its original binding');
              expect(await objects.model.count()).toBe(0);
              expect(await fs.readFile(location())).toEqual(bytes);
            },
          );

          it('rechecks final destroy authorization after the object evidence write', async () => {
            const ctx = await context(1, {}, 'destroy');
            const create = objects.model.create;
            vi.spyOn(objects.model, 'create').mockImplementationOnce(async function (...args) {
              const row = await create.apply(this, args);
              Object.assign(ctx.permission as object, { can: false, skip: false });
              return row;
            });
            await expect(
              prepare(ctx, async (proof) => {
                const handle = await persist(proof);
                await journal.persistLocalObject(handle, proof, objects);
              }),
            ).rejects.toThrow('Attachment removal identity, final decision or preparation phase changed');
            expect(await objects.model.count()).toBe(0);
            expect(await intents.model.count()).toBe(0);
          });

          it('does not mistake a prepared handle without an object binding for object evidence', async () => {
            await prepare(await context(1, {}, 'destroy'), async (proof) => {
              const handle = await persist(proof);
              await expect(journal.assertLocalObjectMatches(handle, proof.transaction)).rejects.toThrow(
                'Original removal object binding is unavailable',
              );
            });
          });

          it.each(['rls', 'rule', 'column'])(
            'refuses unsupported object journal behavior before insertion: %s',
            async (kind) => {
              if (kind === 'rls')
                await db.sequelize.query('ALTER TABLE attachment_removal_objects ENABLE ROW LEVEL SECURITY');
              if (kind === 'rule')
                await db.sequelize.query(
                  'CREATE RULE skip_object_insert AS ON INSERT TO attachment_removal_objects DO INSTEAD NOTHING',
                );
              if (kind === 'column')
                await db.sequelize.query('ALTER TABLE attachment_removal_objects ADD COLUMN extra text');
              await expect(
                prepare(await context(1, {}, 'destroy'), async (proof) => {
                  const handle = await persist(proof);
                  await journal.persistLocalObject(handle, proof, objects);
                }),
              ).rejects.toThrow(
                kind === 'column'
                  ? 'Removal intent table requires its own primary key and no references or extra columns'
                  : 'Completion journal has unsupported database behavior',
              );
              expect(await intents.model.count()).toBe(0);
              expect(await objects.model.count()).toBe(0);
            },
          );

          it('observes real CHECK-function business writes after insertion and rolls the whole preparation back', async () => {
            await db.sequelize.query(`
              CREATE FUNCTION tamper_removal_object(value jsonb) RETURNS boolean LANGUAGE plpgsql AS $$
              BEGIN UPDATE documents SET "tenantId"='H' WHERE id=1; RETURN true; END $$;
              ALTER TABLE attachment_removal_objects ADD CONSTRAINT check_object CHECK (tamper_removal_object(payload));
            `);
            await expect(
              prepare(await context(1, {}, 'destroy'), async (proof) => {
                const handle = await persist(proof);
                await journal.persistLocalObject(handle, proof, objects);
              }),
            ).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
            expect((await docs.model.findByPk(1)).getDataValue('tenantId')).toBe('B');
            expect(await intents.model.count()).toBe(0);
            expect(await objects.model.count()).toBe(0);
            expect(await fs.readFile(location())).toEqual(bytes);
          });

          it('detects a replaced physical source even if its name and every stored record value are preserved', async () => {
            await expect(
              prepare(await context(1, {}, 'destroy'), async (proof) => {
                const handle = await persist(proof);
                await journal.persistLocalObject(handle, proof, objects);
                await db.sequelize.query(
                  `
                CREATE TABLE replacement_documents (LIKE documents INCLUDING ALL);
                INSERT INTO replacement_documents SELECT * FROM documents;
                DROP TABLE documents;
                ALTER TABLE replacement_documents RENAME TO documents;
              `,
                  { transaction: proof.transaction },
                );
                await journal.assertLocalObjectMatches(handle, proof.transaction);
              }),
            ).rejects.toThrow('Removal object source physical identity changed');
            expect(await intents.model.count()).toBe(0);
            expect(await objects.model.count()).toBe(0);
            expect(await docs.model.count()).toBe(3);
          });

          it.each(['intents', 'objects'])(
            'rejects a physically replaced evidence table with copied exact rows: %s',
            async (kind) => {
              await expect(
                prepare(await context(1, {}, 'destroy'), async (proof) => {
                  const handle = await persist(proof);
                  await journal.persistLocalObject(handle, proof, objects);
                  // Fixed fixture identifiers only; both replacements live in this test transaction.
                  const table = kind === 'intents' ? 'attachment_removal_intents' : 'attachment_removal_objects';
                  await db.sequelize.query(
                    `
                CREATE TABLE replacement_evidence (LIKE ${table} INCLUDING ALL);
                INSERT INTO replacement_evidence SELECT * FROM ${table};
                DROP TABLE ${table};
                ALTER TABLE replacement_evidence RENAME TO ${table};
              `,
                    { transaction: proof.transaction },
                  );
                  await journal.assertLocalObjectMatches(handle, proof.transaction);
                }),
              ).rejects.toThrow(/Removal object .*journal.*identity changed/);
              expect(await intents.model.count()).toBe(0);
              expect(await objects.model.count()).toBe(0);
            },
          );
        });

        // A committed intent is observable from another pool, but the original record and bytes remain.
        it('commits only a prepared intent with the original location and retention policy', async () => {
          journal = undefined;
          await db.getRepository('storages').update({ filterByTk: 18, values: { paranoid: true } });
          const result = await prepare(await context(1, {}, 'destroy'), async (proof) => {
            const recorded = await persist(proof);
            expect(await intents.model.count({ transaction: proof.transaction })).toBe(1);
            return recorded;
          });
          const other = isolatedPostgresDatabase(postgresUrl!);
          try {
            const [rows] = await other.sequelize.query('SELECT id, payload FROM attachment_removal_intents');
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
              id: result.id,
              payload: {
                schemaVersion: 2,
                kind: 'attachment-removal-intent',
                state: 'prepared',
                source: { collectionName: 'documents', primaryKey: 'id' },
                record: { key: 1, path: 'old/tenants/H', filename: 'receipt.txt', storageId: 18, size: bytes.length },
                storage: { root, retainContent: true },
              },
            });
            expect(JSON.stringify(rows)).not.toContain('baseUrl');
          } finally {
            await other.close();
          }
          expect(await docs.model.count()).toBe(3);
          expect(await fs.readFile(location())).toEqual(bytes);
        });

        it('binds preparation to the actual PostgreSQL transaction, physical source and stored owner', async () => {
          let firstTransaction: string;
          let sourceOid: string;
          const first = await prepare(await context(1, {}, 'destroy'), async (proof) => {
            const [actual] = await db.sequelize.query(
              `SELECT txid_current()::text AS transaction_id, 'documents'::regclass::oid::text AS source_oid`,
              { transaction: proof.transaction },
            );
            firstTransaction = actual[0].transaction_id;
            sourceOid = actual[0].source_oid;
            return persist(proof);
          });
          const firstPayload = (await intents.model.findByPk(first.id)).getDataValue('payload');
          expect(firstPayload).toMatchObject({
            schemaVersion: 2,
            state: 'prepared',
            transactionId: firstTransaction!,
            source: { oid: sourceOid!, schema: 'public', tableName: 'documents', primaryField: 'id' },
            record: { key: 1, tenantId: 'B' },
          });
          const second = await prepare(await context(1, {}, 'destroy'), persist);
          const secondPayload = (await intents.model.findByPk(second.id)).getDataValue('payload');
          expect(secondPayload.transactionId).toMatch(/^\d+$/);
          expect(secondPayload.transactionId).not.toBe(firstTransaction!);
          expect(secondPayload.source.oid).toBe(sourceOid!);
          expect(await docs.model.count()).toBe(3);
          expect(await fs.readFile(location())).toEqual(bytes);
        });

        it('stores the actual owner when G permits access to another tenant rather than substituting the actor', async () => {
          const store = new AccessConfigStore(db, (value) =>
            resolveModelMetadata(db.getCollection(value.collectionName), {
              resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
            }),
          );
          const saved = await store.read(mainIdentity);
          await store.save(
            mainIdentity,
            { ...configFor({ type: 'constant', value: true }), revision: saved!.revision },
            { userId: 28 },
          );
          const result = await prepare(await context(2, {}, 'destroy'), persist);
          expect((await intents.model.findByPk(result.id)).getDataValue('payload').record).toMatchObject({
            key: 2,
            tenantId: 'H',
          });
          expect((await docs.model.findByPk(2)).getDataValue('tenantId')).toBe('H');
          expect(await fs.readFile(location())).toEqual(bytes);
        });

        it('rolls back the intent together with the caller business transaction', async () => {
          journal = undefined;
          await expect(
            prepare(await context(1, {}, 'destroy'), async (proof) => {
              await persist(proof);
              throw new Error('caller rollback');
            }),
          ).rejects.toThrow('caller rollback');
          expect(await intents.model.count()).toBe(0);
          expect(await docs.model.count()).toBe(3);
          expect(await fs.readFile(location())).toEqual(bytes);
        });

        it('does not keep an intent when the final destroy decision changes during insertion', async () => {
          journal = undefined;
          const ctx = await context(1, {}, 'destroy');
          const create = intents.model.create;
          vi.spyOn(intents.model, 'create').mockImplementationOnce(async function (...args) {
            const row = await create.apply(this, args);
            Object.assign(ctx.permission as object, { can: false, skip: false });
            return row;
          });
          await expect(prepare(ctx, persist)).rejects.toThrow();
          expect(await intents.model.count()).toBe(0);
          expect(await fs.readFile(location())).toEqual(bytes);
        });

        it('refuses an expired preparation instead of writing on another transaction', async () => {
          journal = undefined;
          let saved: files.AuthorizedAttachmentRemovalPreparation;
          await prepare(await context(1, {}, 'destroy'), async (proof) => {
            saved = proof;
          });
          await expect(persist(saved!)).rejects.toThrow();
          expect(await intents.model.count()).toBe(0);
        });

        it.each([2, 3])('does not persist a deletion intent for visible-only or hidden record %s', async (key) => {
          await expect(prepare(await context(key, {}, 'destroy'), persist)).rejects.toThrow();
          expect(await intents.model.count()).toBe(0);
          expect(await fs.readFile(location())).toEqual(bytes);
        });

        it('does not treat a remote storage as a local removal intent', async () => {
          await db.getRepository('storages').update({ filterByTk: 18, values: { type: 's3' } });
          await expect(prepare(await context(1, {}, 'destroy'), persist)).rejects.toThrow();
          expect(await intents.model.count()).toBe(0);
          expect(await fs.readFile(location())).toEqual(bytes);
        });

        it('rejects a caller savepoint in place of the original top-level transaction', async () => {
          await prepare(await context(1, {}, 'destroy'), async (proof) => {
            await expect(
              db.sequelize.transaction({ transaction: proof.transaction }, (savepoint) =>
                persist({ ...proof, transaction: savepoint }),
              ),
            ).rejects.toThrow();
            await proof.assertCurrent();
          });
          expect(await intents.model.count()).toBe(0);
          expect(await fs.readFile(location())).toEqual(bytes);
        });

        it('rejects a journal in another database instance even when it has the same table', async () => {
          const other = isolatedPostgresDatabase(postgresUrl!);
          try {
            const collection = other.collection({
              name: 'attachment_removal_intents',
              autoGenId: false,
              timestamps: false,
              fields: [
                { name: 'id', type: 'string', primaryKey: true },
                { name: 'payload', type: 'jsonb' },
              ],
            });
            const otherJournal = new files.AttachmentRemovalIntentJournal(collection);
            await expect(
              prepare(await context(1, {}, 'destroy'), (proof) => otherJournal.persist(proof)),
            ).rejects.toThrow();
            expect(await intents.model.count()).toBe(0);
          } finally {
            await other.close();
          }
        });

        it.each(['column', 'primary'])('refuses actual journal schema drift: %s', async (kind) => {
          journal = undefined;
          if (kind === 'column')
            await db.sequelize.query('ALTER TABLE attachment_removal_intents ADD COLUMN extra text');
          else
            await db.sequelize.query(
              'ALTER TABLE attachment_removal_intents DROP CONSTRAINT attachment_removal_intents_pkey',
            );
          await expect(prepare(await context(1, {}, 'destroy'), persist)).rejects.toThrow();
          expect(await intents.model.count()).toBe(0);
          expect(await docs.model.count()).toBe(3);
        });

        it('rejects a database trigger rewriting the stored intent', async () => {
          journal = undefined;
          await db.sequelize.query(`
            CREATE FUNCTION tamper_removal_intent() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN UPDATE attachment_removal_intents SET payload = '{"state":"completed"}'::jsonb WHERE id = NEW.id;
            RETURN NEW; END $$;
            CREATE TRIGGER tamper_intent AFTER INSERT ON attachment_removal_intents
              FOR EACH ROW EXECUTE FUNCTION tamper_removal_intent();
          `);
          await expect(prepare(await context(1, {}, 'destroy'), persist)).rejects.toThrow();
          expect(await intents.model.count()).toBe(0);
          expect(await fs.readFile(location())).toEqual(bytes);
        });

        describe('native event matching', () => {
          let events: Collection;
          let native: InstanceType<typeof files.AttachmentRemovalNativeCapture>;

          beforeEach(async () => {
            events = db.collection({
              name: 'attachment_removal_events',
              schema: 'public',
              autoGenId: false,
              timestamps: false,
              fields: [
                { name: 'id', type: 'string', primaryKey: true },
                { name: 'payload', type: 'jsonb' },
              ],
            });
            await events.model.sync();
            native = new files.AttachmentRemovalNativeCapture(docs, events);
            await db.sequelize.transaction((transaction) => native.install(transaction));
          });

          afterEach(async () => {
            await db.sequelize.query(`DROP FUNCTION IF EXISTS ${native.functionName}() CASCADE`);
            await db.sequelize.query('DROP FUNCTION IF EXISTS tamper_native_evidence() CASCADE');
          });

          async function markedDelete(transaction: Transaction, id: string) {
            await db.sequelize.query('SELECT set_config($setting, $id, true)', {
              transaction,
              bind: { setting: native.setting, id },
            });
            // Observation fixture only; deliberately bypasses the separate owned deletion executor.
            await docs.repository.destroy({ filterByTk: 1, transaction });
          }

          async function exercise(consume: (handle: Readonly<{ id: string }>, tx: Transaction) => Promise<void>) {
            const entry = mutations.captureAttachmentRemoval(await context(1, {}, 'destroy'), {
              tenantId: 'B',
              roleName: 'reader',
              userId: 28,
            });
            await db.sequelize.transaction(async (transaction) => {
              const handle = await files.withAuthorizedAttachmentRemovalStorage(entry, transaction, persist);
              await markedDelete(transaction, handle.id);
              await consume(handle, transaction);
            });
          }

          it('matches actual OLD to the original intent after preparation expires without touching bytes', async () => {
            docs.model.addHook('beforeDestroy', (row) => row.setDataValue('filename', 'memory-only.txt'));
            await exercise((handle, transaction) => journal.assertNativeEventMatches(handle, native, transaction));
            expect(await docs.model.findByPk(1)).toBeNull();
            expect(await intents.model.count()).toBe(1);
            expect(await events.model.count()).toBe(1);
            expect(await fs.readFile(location())).toEqual(bytes);
          });

          it('does not silently downgrade a full-row v2 event through the location-only intent matcher', async () => {
            await db.sequelize.query(`DROP FUNCTION ${native.functionName}() CASCADE`);
            native = new files.AttachmentRemovalNativeCapture(docs, events, 'full-row');
            await db.sequelize.transaction((transaction) => native.install(transaction));
            await expect(
              exercise(async (handle, transaction) => {
                expect(await native.readEvent(docs, transaction, handle.id)).toMatchObject({
                  schemaVersion: 2,
                  row: { id: 1, tenantId: 'B' },
                });
                await journal.assertNativeEventMatches(handle, native, transaction);
              }),
            ).rejects.toThrow('Native attachment event does not match its prepared intent');
            expect(await docs.model.count()).toBe(3);
            expect(await intents.model.count()).toBe(0);
            expect(await events.model.count()).toBe(0);
            expect(await fs.readFile(location())).toEqual(bytes);
          });

          describe('full native row predicate observation', () => {
            let facts: Collection;
            beforeEach(async () => {
              await db.sequelize.query(`DROP FUNCTION ${native.functionName}() CASCADE`);
              facts = db.collection({
                name: 'removalPolicyFacts',
                timestamps: false,
                fields: [
                  { name: 'documentId', type: 'integer' },
                  { name: 'allowed', type: 'boolean' },
                  { name: 'authorized', type: 'boolean' },
                ],
              });
              docs.setField('facts', {
                type: 'hasMany',
                target: 'removalPolicyFacts',
                foreignKey: 'documentId',
                constraints: false,
              });
              await facts.model.sync();
              await facts.model.create({ documentId: 1, allowed: true, authorized: true });
              const store = new AccessConfigStore(db, (value) =>
                resolveModelMetadata(db.getCollection(value.collectionName), {
                  resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
                }),
              );
              const saved = await store.read(mainIdentity);
              await store.save(
                mainIdentity,
                {
                  ...configFor({
                    type: 'all',
                    children: [
                      ownerCondition,
                      {
                        type: 'compare',
                        operator: 'eq',
                        left: { type: 'field', path: 'viewable' },
                        right: { type: 'literal', value: false },
                      },
                      {
                        type: 'exists',
                        path: 'facts',
                        condition: {
                          type: 'compare',
                          operator: 'eq',
                          left: { type: 'field', path: 'allowed' },
                          right: { type: 'literal', value: true },
                        },
                      },
                    ],
                  }),
                  revision: saved!.revision,
                },
                { userId: 28 },
              );
              native = new files.AttachmentRemovalNativeCapture(docs, events, 'full-row');
              await db.sequelize.transaction((transaction) => native.install(transaction));
            });

            async function exerciseRow(
              consume: (
                handle: Readonly<{ id: string }>,
                transaction: Transaction,
                predicate: { sql: string; rootAlias: string },
              ) => Promise<void>,
            ) {
              const entry = mutations.captureAttachmentRemoval(
                await context(1, { filter: { facts: { authorized: true } } }, 'destroy'),
                { tenantId: 'B', roleName: 'reader', userId: 28 },
              );
              await db.sequelize.transaction(
                { isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE },
                async (transaction) => {
                  let predicate: { sql: string; rootAlias: string };
                  const preparation: files.AuthorizedAttachmentRemovalEntry = {
                    withRecord(consume, tx) {
                      return entry.withNativePredicate(async (proof) => {
                        predicate = Object.freeze({ sql: proof.sql, rootAlias: proof.rootAlias });
                        return consume(proof);
                      }, tx);
                    },
                  };
                  const handle = await files.withAuthorizedAttachmentRemovalStorage(preparation, transaction, persist);
                  // Fixture DELETE is after the unchanged preparation postcondition has completed.
                  await markedDelete(transaction, handle.id);
                  await consume(handle, transaction, predicate!);
                },
              );
            }

            it('evaluates complete compiled G and role SQL against the actual OLD after the source row is absent', async () => {
              await exerciseRow(async (handle, transaction, predicate) => {
                expect(await docs.model.findByPk(1, { transaction })).toBeNull();
                expect(await journal.testNativeRowPredicate(handle, native, transaction, predicate)).toBe(true);
              });
              expect(await docs.model.count()).toBe(2);
              expect(await fs.readFile(location())).toEqual(bytes);
            });

            it('keeps compiler dollar tokens and quotes in original locations as literal SQL values', async () => {
              await docs.model.update({ path: "old/$tac_0/it's here", filename: '$tac_1.txt' }, { where: { id: 1 } });
              await exerciseRow(async (handle, transaction, predicate) => {
                expect(await journal.testNativeRowPredicate(handle, native, transaction, predicate)).toBe(true);
              });
              expect(await fs.readFile(location())).toEqual(bytes);
            });

            it('evaluates actual scalar G changed by beforeDestroy rather than the old model instance', async () => {
              docs.model.addHook('beforeDestroy', async (_row, { transaction }) => {
                await docs.model.update({ viewable: true }, { where: { id: 1 }, hooks: false, transaction });
              });
              await expect(
                exerciseRow(async (handle, transaction, predicate) => {
                  expect(await journal.testNativeRowPredicate(handle, native, transaction, predicate)).toBe(false);
                  throw new Error('rollback observed denied predicate');
                }),
              ).rejects.toThrow('rollback observed denied predicate');
              expect((await docs.model.findByPk(1)).getDataValue('viewable')).toBe(false);
              expect(await events.model.count()).toBe(0);
            });

            it.each([
              ['G', 'beforeDestroy'],
              ['role', 'beforeDestroy'],
              ['G', 'later AFTER'],
              ['role', 'later AFTER'],
              ['G', 'afterDestroy'],
              ['role', 'afterDestroy'],
            ])('observes %s relation revocation in %s after preparation', async (scope, timing) => {
              const field = scope === 'G' ? 'allowed' : 'authorized';
              if (timing === 'later AFTER')
                await db.sequelize
                  .query(`CREATE FUNCTION tamper_native_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
                  BEGIN UPDATE "removalPolicyFacts" SET ${field}=FALSE WHERE "documentId"=OLD.id; RETURN OLD; END $$;
                  CREATE TRIGGER zz_revoke_row_policy AFTER DELETE ON documents FOR EACH ROW EXECUTE FUNCTION tamper_native_evidence()`);
              else
                docs.model.addHook(timing, async (_row, { transaction }) => {
                  await facts.model.update({ [field]: false }, { where: { documentId: 1 }, transaction });
                });
              await expect(
                exerciseRow(async (handle, transaction, predicate) => {
                  expect(await journal.testNativeRowPredicate(handle, native, transaction, predicate)).toBe(false);
                  throw new Error('rollback observed denied predicate');
                }),
              ).rejects.toThrow('rollback observed denied predicate');
              expect(await docs.model.count()).toBe(3);
              expect((await facts.model.findOne()).getDataValue(field)).toBe(true);
              expect(await intents.model.count()).toBe(0);
              expect(await events.model.count()).toBe(0);
              expect(await fs.readFile(location())).toEqual(bytes);
            });

            it.each([
              'row key',
              'row location',
              'row owner',
              'missing field',
              'extra field',
              'string boolean',
              'extra header',
              'transaction',
            ])('rejects %s evidence inconsistency before treating a true predicate as a match', async (change) => {
              await expect(
                exerciseRow(async (handle, transaction, predicate) => {
                  const row = await events.model.findByPk(handle.id, { transaction });
                  const payload = row.getDataValue('payload');
                  if (change === 'row key') payload.row.id = 999;
                  else if (change === 'row location') payload.row.path = 'another/path';
                  else if (change === 'row owner') payload.row.tenantId = 'H';
                  else if (change === 'missing field') delete payload.row.viewable;
                  else if (change === 'extra field') payload.row.unmodeled = true;
                  else if (change === 'string boolean') payload.row.viewable = 'false';
                  else if (change === 'extra header') payload.extra = true;
                  else payload.transactionId = '1';
                  await events.model.update({ payload }, { where: { id: handle.id }, transaction, hooks: false });
                  await journal.testNativeRowPredicate(handle, native, transaction, predicate);
                }),
              ).rejects.toThrow('Native full-row event does not match its prepared intent');
              expect(await docs.model.count()).toBe(3);
              expect(await events.model.count()).toBe(0);
            });

            it('requires the exact original intent handle rather than a copied identifier', async () => {
              await expect(
                exerciseRow(async (handle, transaction, predicate) => {
                  await journal.testNativeRowPredicate({ id: handle.id }, native, transaction, predicate);
                }),
              ).rejects.toThrow('Original removal intent handle is unavailable');
              expect(await docs.model.count()).toBe(3);
            });

            it('rejects a different active transaction instead of reusing an original preparation', async () => {
              await expect(
                exerciseRow(async (handle, _transaction, predicate) => {
                  await db.sequelize.transaction((other) =>
                    journal.testNativeRowPredicate(handle, native, other, predicate),
                  );
                }),
              ).rejects.toThrow('Original removal intent transaction is unavailable');
              expect(await docs.model.count()).toBe(3);
            });

            it('rereads the actually stored intent before observing the full row', async () => {
              await expect(
                exerciseRow(async (handle, transaction, predicate) => {
                  await intents.model.update(
                    { payload: { state: 'completed' } },
                    {
                      where: { id: handle.id },
                      hooks: false,
                      transaction,
                    },
                  );
                  await journal.testNativeRowPredicate(handle, native, transaction, predicate);
                }),
              ).rejects.toThrow('Removal intent no longer matches its original preparation');
              expect(await docs.model.count()).toBe(3);
              expect(await intents.model.count()).toBe(0);
            });

            describe('owned native removal execution', () => {
              async function execution(key = 1, recordCompletion = false) {
                journal ??= new files.AttachmentRemovalIntentJournal(intents);
                const ctx = await context(key, { filter: { facts: { authorized: true } } }, 'destroy');
                return {
                  ctx,
                  entry: mutations.captureAttachmentRemoval(ctx, { tenantId: 'B', roleName: 'reader', userId: 28 }),
                  evidence: files.createAttachmentRemovalEvidenceAdapter(
                    journal,
                    native,
                    recordCompletion ? { recordCompletion: true } : undefined,
                  ),
                };
              }
              async function assertRollback() {
                expect(await docs.model.count()).toBe(3);
                expect(await intents.model.count()).toBe(0);
                expect(await events.model.count()).toBe(0);
                expect((await facts.model.findOne()).getDataValue('allowed')).toBe(true);
                expect((await facts.model.findOne()).getDataValue('authorized')).toBe(true);
                expect(await fs.readFile(location())).toEqual(bytes);
              }

              describe('optional SQL completion', () => {
                describe('independent completion inspection', () => {
                  describe('recorded execution outcome correlation', () => {
                    describe('optional bound local removal execution', () => {
                      let objects: Collection;

                      beforeEach(async () => {
                        objects = db.collection({
                          name: 'attachment_removal_objects',
                          autoGenId: false,
                          timestamps: false,
                          fields: [
                            { name: 'id', type: 'string', primaryKey: true },
                            { name: 'payload', type: 'jsonb' },
                          ],
                        });
                        await objects.model.sync();
                      });

                      afterEach(async () => {
                        await db.sequelize.query('DROP FUNCTION IF EXISTS tamper_bound_completion(jsonb) CASCADE');
                      });

                      async function runBound() {
                        const { entry } = await execution();
                        return files.executeRecordedAttachmentRemoval(entry, journal, native, {
                          localObjects: objects,
                        });
                      }

                      describe('independent committed reference inspection', () => {
                        const mappedFiles = () =>
                          [...db.collections.values()].filter((value) => value.options.template === 'file');
                        const references = () => observer(objects, mappedFiles());

                        describe('owned verified reference reservation', () => {
                          let fenceJournal: Collection;
                          let fence: files.AttachmentRemovalReferenceWriteFence;
                          beforeEach(async () => {
                            await db.getCollection('storages').model.update({ paranoid: false }, { where: { id: 18 } });
                            fenceJournal = db.collection({
                              name: 'verified_reference_fence',
                              schema: 'public',
                              timestamps: false,
                              fields: [
                                { name: 'id', type: 'string', primaryKey: true },
                                { name: 'payload', type: 'jsonb' },
                              ],
                            });
                            await fenceJournal.model.sync();
                            fence = new files.AttachmentRemovalReferenceWriteFence(
                              db,
                              mappedFiles(),
                              db.getCollection('storages'),
                              fenceJournal,
                            );
                            await db.sequelize.transaction(
                              { isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE },
                              (tx) => fence.install(tx),
                            );
                          });
                          afterEach(async () => {
                            if (fence)
                              await db.sequelize.query(`DROP FUNCTION IF EXISTS ${fence.functionName}() CASCADE`);
                          });
                          const coordinated = () => observer(objects, mappedFiles(), fenceJournal);
                          const unreferenced = async () => {
                            const result = await runBound();
                            // Privileged isolated fixture removes other retained references, never file bytes.
                            await db.sequelize.query('DELETE FROM documents WHERE id IN (2,3)');
                            return result.operationId;
                          };

                          describe('independent durable reference reservation inspection', () => {
                            const reserved = async () => {
                              const id = await unreferenced();
                              const other = await coordinated();
                              try {
                                return { id, reservation: await other.inspector.reserveLocalReferences(id) };
                              } finally {
                                await other.db.close();
                              }
                            };
                            const changeBinding = async (fields: string[], value: unknown) => {
                              await db.sequelize.query(
                                'UPDATE verified_reference_fence SET payload=jsonb_set(payload,$fields::text[],$value::jsonb)',
                                { bind: { fields: ['binding', ...fields], value: JSON.stringify(value) } },
                              );
                            };

                            // Integration characterization only: no product coordinator or irreversible command.
                            describe.skipIf(process.platform !== 'win32')(
                              'live fixture session and owned attempt composition',
                              () => {
                                let sessionDirectory: string;
                                let sessionFile: string;
                                const sessions = new Set<
                                  Awaited<ReturnType<typeof openReadOnlyRemovalFixtureSession>>
                                >();
                                beforeEach(async () => {
                                  sessionDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'tego-removal-session-'));
                                  const sessionRoot = path.join(sessionDirectory, 'root');
                                  await fs.mkdir(path.join(sessionRoot, 'nested'), { recursive: true });
                                  sessionFile = path.join(sessionRoot, 'nested', 'attachment.txt');
                                  await fs.writeFile(sessionFile, bytes, { flag: 'wx' });
                                  await db
                                    .getCollection('storages')
                                    .model.update({ options: { documentRoot: sessionRoot } }, { where: { id: 18 } });
                                  await docs.model.update(
                                    { path: 'nested', filename: 'attachment.txt' },
                                    { where: {} },
                                  );
                                });
                                afterEach(async () => {
                                  for (const session of sessions) await session.terminate();
                                  sessions.clear();
                                  if (sessionDirectory) await fs.rm(sessionDirectory, { recursive: true, force: true });
                                });
                                const hold = async () => {
                                  const session = await openReadOnlyRemovalFixtureSession(sessionDirectory);
                                  sessions.add(session);
                                  return session;
                                };
                                const assertOriginalBinding = async (
                                  id: string,
                                  session: Awaited<ReturnType<typeof hold>>,
                                ) => {
                                  const bound = (await objects.model.findByPk(id)).getDataValue('payload').object;
                                  const observed = await session.observe();
                                  expect(observed.file).toMatchObject({
                                    ...bound.object,
                                    nlink: '1',
                                    directory: false,
                                    reparse: false,
                                  });
                                  expect(bound.directories).toHaveLength(2);
                                  expect(bound.directories.map((value) => value.path)).toEqual(['', 'nested']);
                                  for (const [index, value] of bound.directories.entries()) {
                                    const { path: _relative, ...identity } = value;
                                    expect(observed.directories[index + 1]).toMatchObject({
                                      ...identity,
                                      directory: true,
                                      reparse: false,
                                    });
                                  }
                                  return observed;
                                };
                                const begin = async () => {
                                  const session = await hold();
                                  const result = await reserved();
                                  await assertOriginalBinding(result.id, session);
                                  return { ...result, session };
                                };
                                const state = async () => {
                                  const [rows] = await db.sequelize.query(
                                    'SELECT xmin::text,ctid::text,payload FROM verified_reference_fence',
                                  );
                                  return rows;
                                };

                                it('retains the same live handles across actual removal, reservation and owned attempt commits', async () => {
                                  const { id, reservation, session } = await begin();
                                  const other = await coordinated();
                                  try {
                                    const recorded = await other.inspector.recordLocalCleanupAttempt(id);
                                    expect(recorded).toMatchObject({
                                      state: 'committed-cleanup-attempt-recorded',
                                      operationId: id,
                                      reservationTransactionId: reservation.transactionId,
                                    });
                                    const observed = await assertOriginalBinding(id, session);
                                    expect(observed.file).toEqual(session.initial.file);
                                    const payload = (await fenceJournal.model.findOne()).getDataValue('payload');
                                    expect(payload.attempt).toMatchObject({
                                      state: 'unresolved',
                                      attemptId: recorded.attemptId,
                                      reservation: payload.binding,
                                    });
                                    const before = await state();
                                    expect(await other.inspector.inspectLocalCleanupAttempt(id)).toMatchObject({
                                      state: 'committed-cleanup-attempt-observed',
                                      attemptId: recorded.attemptId,
                                      transactionId: recorded.transactionId,
                                    });
                                    expect(await state()).toEqual(before);
                                    await expect(openReadOnlyRemovalFixtureSession(sessionDirectory)).rejects.toThrow(
                                      'busy',
                                    );
                                    expect(await fs.readFile(sessionFile)).toEqual(bytes);
                                    await session.close();
                                  } finally {
                                    await other.db.close();
                                  }
                                });

                                it('fails native acquisition before creating SQL evidence or reserving a cleanup attempt', async () => {
                                  const before = await state();
                                  const writer = await fs.open(sessionFile, 'r+');
                                  try {
                                    await expect(begin()).rejects.toThrow('native');
                                    expect(await intents.model.count()).toBe(0);
                                    expect(await objects.model.count()).toBe(0);
                                    expect(await docs.model.count()).toBe(3);
                                    expect(await state()).toEqual(before);
                                    expect(await fs.readFile(sessionFile)).toEqual(bytes);
                                  } finally {
                                    await writer.close();
                                  }
                                });

                                it('preserves committed unresolved after an actual afterCommit error while the original session is alive', async () => {
                                  const { id, session } = await begin();
                                  const other = await coordinated();
                                  let registered = false;
                                  other.db.sequelize.addHook(
                                    'afterQuery',
                                    'live-attempt-after-commit',
                                    (options, query) => {
                                      const sql = (query as unknown as { sql: string }).sql;
                                      if (
                                        !registered &&
                                        sql.startsWith('UPDATE ') &&
                                        sql.includes('attachment-removal-cleanup-attempt')
                                      ) {
                                        registered = true;
                                        (options as { transaction: Transaction }).transaction.afterCommit(() => {
                                          throw new Error('live fixture afterCommit failed');
                                        });
                                      }
                                    },
                                  );
                                  try {
                                    await expect(other.inspector.recordLocalCleanupAttempt(id)).rejects.toThrow(
                                      'live fixture afterCommit failed',
                                    );
                                    expect(registered).toBe(true);
                                    await assertOriginalBinding(id, session);
                                  } finally {
                                    other.db.sequelize.removeHook('afterQuery', 'live-attempt-after-commit');
                                    await other.db.close();
                                    await session.close();
                                  }
                                  const fresh = await coordinated();
                                  try {
                                    const before = await state();
                                    expect(await fresh.inspector.inspectLocalCleanupAttempt(id)).toMatchObject({
                                      state: 'committed-cleanup-attempt-observed',
                                    });
                                    await expect(fresh.inspector.recordLocalCleanupAttempt(id)).rejects.toThrow(
                                      'already recorded',
                                    );
                                    expect(await state()).toEqual(before);
                                    expect(await fs.readFile(sessionFile)).toEqual(bytes);
                                  } finally {
                                    await fresh.db.close();
                                  }
                                });

                                it('does not mistake a committed attempt for broker survival when the broker really dies inside the transaction', async () => {
                                  const { id, session } = await begin();
                                  const other = await coordinated();
                                  let terminated = false;
                                  other.db.sequelize.addHook(
                                    'afterQuery',
                                    'live-attempt-death',
                                    async (_options, query) => {
                                      const sql = (query as unknown as { sql: string }).sql;
                                      if (
                                        !terminated &&
                                        sql.startsWith('UPDATE ') &&
                                        sql.includes('attachment-removal-cleanup-attempt')
                                      ) {
                                        terminated = true;
                                        await session.terminate();
                                      }
                                    },
                                  );
                                  try {
                                    // Existing recorder has no live-session input. This success is a gap, not execution authority.
                                    const recorded = await other.inspector.recordLocalCleanupAttempt(id);
                                    expect(terminated).toBe(true);
                                    expect(recorded.state).toBe('committed-cleanup-attempt-recorded');
                                    await expect(session.observe()).rejects.toThrow('session ended');
                                    expect(await other.inspector.inspectLocalCleanupAttempt(id)).toMatchObject({
                                      attemptId: recorded.attemptId,
                                      state: 'committed-cleanup-attempt-observed',
                                    });
                                    await expect(other.inspector.recordLocalCleanupAttempt(id)).rejects.toThrow(
                                      'already recorded',
                                    );
                                    expect(await fs.readFile(sessionFile)).toEqual(bytes);
                                  } finally {
                                    other.db.sequelize.removeHook('afterQuery', 'live-attempt-death');
                                    await other.db.close();
                                  }
                                });

                                it('rolls back the attempt when an actual hardlink is introduced while the original native handles are held', async () => {
                                  const { id, session } = await begin();
                                  const before = await state();
                                  const other = await coordinated();
                                  const alias = path.join(sessionDirectory, 'fixture-alias.txt');
                                  let linked = false;
                                  other.db.sequelize.addHook(
                                    'afterQuery',
                                    'live-attempt-link',
                                    async (_options, query) => {
                                      const sql = (query as unknown as { sql: string }).sql;
                                      if (
                                        !linked &&
                                        sql.startsWith('UPDATE ') &&
                                        sql.includes('attachment-removal-cleanup-attempt')
                                      ) {
                                        linked = true;
                                        await fs.link(sessionFile, alias);
                                      }
                                    },
                                  );
                                  try {
                                    await expect(other.inspector.recordLocalCleanupAttempt(id)).rejects.toThrow();
                                    expect(linked).toBe(true);
                                    expect((await fs.stat(sessionFile, { bigint: true })).nlink).toBe(2n);
                                    expect(await state()).toEqual(before);
                                    await expect(session.observe()).rejects.toThrow('identity');
                                    expect(await fs.readFile(sessionFile)).toEqual(bytes);
                                    expect(await fs.readFile(alias)).toEqual(bytes);
                                  } finally {
                                    other.db.sequelize.removeHook('afterQuery', 'live-attempt-link');
                                    await other.db.close();
                                  }
                                });

                                describe('actual COMMIT response loss', () => {
                                  let proxy: Awaited<ReturnType<typeof createRemovalCommitProxy>>;
                                  beforeAll(async () => {
                                    proxy = await createRemovalCommitProxy(postgresUrl!);
                                    testPostgresUrl = proxy.url;
                                  });
                                  afterAll(async () => {
                                    testPostgresUrl = postgresUrl;
                                    await proxy?.close();
                                  });

                                  describe('owned read-only rehearsal', () => {
                                    const owners = new Set<
                                      Awaited<ReturnType<typeof openOwnedReadOnlyRemovalFixture>>
                                    >();
                                    afterEach(async () => {
                                      for (const owner of owners) await owner.close();
                                      owners.clear();
                                    });
                                    const startOwned = async () => {
                                      const pool = await coordinated();
                                      const owner = await openOwnedReadOnlyRemovalFixture(
                                        sessionDirectory,
                                        pool,
                                        objects,
                                      );
                                      owners.add(owner);
                                      const id = await unreferenced();
                                      await pool.inspector.reserveLocalReferences(id);
                                      return { owner, pool, id };
                                    };

                                    it('owns the original native session and attempt through one final read-only observation', async () => {
                                      const { owner, id } = await startOwned();
                                      const result = await owner.recordOnce(id);
                                      expect(result).toMatchObject({
                                        state: 'read-only-attempt-rehearsed',
                                        operationId: id,
                                      });
                                      expect(Object.isFrozen(result)).toBe(true);
                                      expect(result).not.toHaveProperty('session');
                                      expect(result).not.toHaveProperty('path');
                                      expect(owner.snapshot()).toEqual({
                                        claimed: true,
                                        closed: true,
                                        finalConsumed: true,
                                        finalProbeCalls: 1,
                                      });
                                      const before = await state();
                                      await expect(owner.recordOnce(id)).rejects.toThrow('already claimed');
                                      expect(await state()).toEqual(before);
                                      expect(await fs.readFile(sessionFile)).toEqual(bytes);
                                      const reopened = await fs.open(sessionFile, 'r+');
                                      await reopened.close();
                                    });

                                    it('claims synchronously before overlapping calls can record or send a final probe twice', async () => {
                                      const { owner, id } = await startOwned();
                                      const results = await Promise.allSettled([
                                        owner.recordOnce(id),
                                        owner.recordOnce(id),
                                      ]);
                                      expect(results[0].status).toBe('fulfilled');
                                      expect(results[1]).toMatchObject({
                                        status: 'rejected',
                                        reason: expect.any(Error),
                                      });
                                      if (results[1].status === 'rejected')
                                        expect(String(results[1].reason)).toContain('already claimed');
                                      expect(owner.snapshot()).toMatchObject({
                                        claimed: true,
                                        closed: true,
                                        finalProbeCalls: 1,
                                      });
                                      expect(
                                        (await fenceJournal.model.findOne()).getDataValue('payload').attempt.state,
                                      ).toBe('unresolved');
                                      expect(await fs.readFile(sessionFile)).toEqual(bytes);
                                    });

                                    it('closes its actual pool when the original native session ended before the first record call', async () => {
                                      const { owner, pool, id } = await startOwned();
                                      const before = await state();
                                      await owner.terminateNative();
                                      await expect(owner.recordOnce(id)).rejects.toThrow('session ended');
                                      expect(await state()).toEqual(before);
                                      expect(owner.snapshot()).toEqual({
                                        claimed: true,
                                        closed: true,
                                        finalConsumed: false,
                                        finalProbeCalls: 0,
                                      });
                                      await expect(pool.db.sequelize.query('SELECT 1')).rejects.toThrow(/closed/i);
                                      await expect(owner.recordOnce(id)).rejects.toThrow('already claimed');
                                      expect(await fs.readFile(sessionFile)).toEqual(bytes);
                                    });

                                    it('sends no final probe after the original broker dies during a genuinely committed attempt', async () => {
                                      const { owner, pool, id } = await startOwned();
                                      let killed = false;
                                      pool.db.sequelize.addHook(
                                        'afterQuery',
                                        'owned-rehearsal-death',
                                        async (_options, query) => {
                                          const sql = (query as unknown as { sql: string }).sql;
                                          if (
                                            !killed &&
                                            sql.startsWith('UPDATE ') &&
                                            sql.includes('attachment-removal-cleanup-attempt')
                                          ) {
                                            killed = true;
                                            await owner.terminateNative();
                                          }
                                        },
                                      );
                                      try {
                                        await expect(owner.recordOnce(id)).rejects.toThrow('session ended');
                                        expect(killed).toBe(true);
                                      } finally {
                                        pool.db.sequelize.removeHook('afterQuery', 'owned-rehearsal-death');
                                      }
                                      expect(owner.snapshot()).toEqual({
                                        claimed: true,
                                        closed: true,
                                        finalConsumed: false,
                                        finalProbeCalls: 0,
                                      });
                                      const fresh = await coordinated();
                                      try {
                                        expect(await fresh.inspector.inspectLocalCleanupAttempt(id)).toMatchObject({
                                          state: 'committed-cleanup-attempt-observed',
                                        });
                                        const before = await state();
                                        await expect(owner.recordOnce(id)).rejects.toThrow('already claimed');
                                        expect(await state()).toEqual(before);
                                      } finally {
                                        await fresh.db.close();
                                      }
                                      expect(await fs.readFile(sessionFile)).toEqual(bytes);
                                    });

                                    it('does not send or resume after a real lost COMMIT confirmation despite later committed history', async () => {
                                      const { owner, id } = await startOwned();
                                      const fault = proxy.arm('after-complete');
                                      await expect(owner.recordOnce(id)).rejects.toThrow(
                                        /terminated|closed|socket|ECONNRESET/i,
                                      );
                                      await fault.observed;
                                      expect(fault.snapshot()).toMatchObject({
                                        commitSeen: 1,
                                        commitForwarded: 1,
                                        completionReceived: 1,
                                        completionDelivered: 0,
                                      });
                                      expect(owner.snapshot()).toEqual({
                                        claimed: true,
                                        closed: true,
                                        finalConsumed: false,
                                        finalProbeCalls: 0,
                                      });
                                      const fresh = await coordinated();
                                      try {
                                        expect(await fresh.inspector.inspectLocalCleanupAttempt(id)).toMatchObject({
                                          state: 'committed-cleanup-attempt-observed',
                                        });
                                        const before = await state();
                                        await expect(owner.recordOnce(id)).rejects.toThrow('already claimed');
                                        await expect(fresh.inspector.recordLocalCleanupAttempt(id)).rejects.toThrow(
                                          'already recorded',
                                        );
                                        expect(await state()).toEqual(before);
                                      } finally {
                                        await fresh.db.close();
                                      }
                                      expect(await fs.readFile(sessionFile)).toEqual(bytes);
                                    });

                                    it('rechecks the original live object after historical observation actually commits', async () => {
                                      const { owner, pool, id } = await startOwned();
                                      const alias = path.join(sessionDirectory, 'late-owned-alias.txt');
                                      let attemptCommitted = false;
                                      let scheduled = false;
                                      let linked = false;
                                      pool.db.sequelize.addHook(
                                        'afterQuery',
                                        'owned-rehearsal-late-link',
                                        (options, query) => {
                                          const sql = (query as unknown as { sql: string }).sql;
                                          const tx = (options as { transaction: Transaction }).transaction;
                                          if (
                                            sql.startsWith('UPDATE ') &&
                                            sql.includes('attachment-removal-cleanup-attempt')
                                          )
                                            tx.afterCommit(() => {
                                              attemptCommitted = true;
                                            });
                                          if (attemptCommitted && !scheduled && sql.startsWith('LOCK TABLE ')) {
                                            scheduled = true;
                                            tx.afterCommit(async () => {
                                              await fs.link(sessionFile, alias);
                                              linked = true;
                                            });
                                          }
                                        },
                                      );
                                      try {
                                        await expect(owner.recordOnce(id)).rejects.toThrow('identity');
                                        expect(attemptCommitted && scheduled && linked).toBe(true);
                                      } finally {
                                        pool.db.sequelize.removeHook('afterQuery', 'owned-rehearsal-late-link');
                                      }
                                      expect(owner.snapshot()).toEqual({
                                        claimed: true,
                                        closed: true,
                                        finalConsumed: false,
                                        finalProbeCalls: 0,
                                      });
                                      const fresh = await coordinated();
                                      try {
                                        expect(await fresh.inspector.inspectLocalCleanupAttempt(id)).toMatchObject({
                                          state: 'committed-cleanup-attempt-observed',
                                        });
                                        const before = await state();
                                        await expect(owner.recordOnce(id)).rejects.toThrow('already claimed');
                                        expect(await state()).toEqual(before);
                                      } finally {
                                        await fresh.db.close();
                                      }
                                      expect((await fs.stat(sessionFile, { bigint: true })).nlink).toBe(2n);
                                      expect(await fs.readFile(sessionFile)).toEqual(bytes);
                                      expect(await fs.readFile(alias)).toEqual(bytes);
                                    });
                                  });

                                  it('normally confirms the owned attempt through the actual bounded TCP transport', async () => {
                                    const { id, session } = await begin();
                                    const other = await coordinated();
                                    try {
                                      const recorded = await other.inspector.recordLocalCleanupAttempt(id);
                                      expect(recorded.state).toBe('committed-cleanup-attempt-recorded');
                                      await assertOriginalBinding(id, session);
                                      expect(await other.inspector.inspectLocalCleanupAttempt(id)).toMatchObject({
                                        state: 'committed-cleanup-attempt-observed',
                                        attemptId: recorded.attemptId,
                                      });
                                      expect(await fs.readFile(sessionFile)).toEqual(bytes);
                                    } finally {
                                      await other.db.close();
                                    }
                                  });

                                  it.each(['before-forward', 'after-complete'] as const)(
                                    'observes the actual durable result without retry after wire loss: %s',
                                    async (mode) => {
                                      const { id, session } = await begin();
                                      const before = await state();
                                      const other = await coordinated();
                                      const fault = proxy.arm(mode);
                                      try {
                                        await expect(other.inspector.recordLocalCleanupAttempt(id)).rejects.toThrow(
                                          /terminated|closed|socket|ECONNRESET/i,
                                        );
                                        await fault.observed;
                                      } finally {
                                        await other.db.close();
                                      }
                                      expect(fault.snapshot()).toMatchObject({
                                        commitSeen: 1,
                                        commitForwarded: mode === 'after-complete' ? 1 : 0,
                                        completionReceived: mode === 'after-complete' ? 1 : 0,
                                        completionDelivered: 0,
                                      });
                                      expect(fault.snapshot().backendProcessId).toBeGreaterThan(0);
                                      // The fixture alone knows where it cut the wire. The failed caller cannot infer this.
                                      await assertOriginalBinding(id, session);
                                      const fresh = await coordinated();
                                      try {
                                        if (mode === 'before-forward') {
                                          expect(await fresh.inspector.inspectLocalCleanupAttempt(id)).toEqual({
                                            state: 'unknown',
                                          });
                                          expect(await state()).toEqual(before);
                                          // No automatic second attempt, even though this controlled transaction did abort.
                                        } else {
                                          const payload = (await fenceJournal.model.findOne()).getDataValue('payload');
                                          expect(payload.attempt).toMatchObject({
                                            state: 'unresolved',
                                            operationId: id,
                                            reservation: payload.binding,
                                          });
                                          expect(await fresh.inspector.inspectLocalCleanupAttempt(id)).toMatchObject({
                                            state: 'committed-cleanup-attempt-observed',
                                            attemptId: payload.attempt.attemptId,
                                            transactionId: payload.attempt.transactionId,
                                          });
                                          const durable = await state();
                                          await expect(fresh.inspector.recordLocalCleanupAttempt(id)).rejects.toThrow(
                                            'already recorded',
                                          );
                                          expect(await state()).toEqual(durable);
                                        }
                                        expect(await fs.readFile(sessionFile)).toEqual(bytes);
                                      } finally {
                                        await fresh.db.close();
                                      }
                                    },
                                  );
                                });
                              },
                            );

                            describe('owned unresolved cleanup attempt recording', () => {
                              it('records one unresolved attempt bound to actual committed evidence without touching bytes', async () => {
                                const { id, reservation } = await reserved();
                                const before = (await fenceJournal.model.findOne()).getDataValue('payload');
                                const other = await coordinated();
                                try {
                                  const result = await other.inspector.recordLocalCleanupAttempt(id);
                                  expect(result).toMatchObject({
                                    state: 'committed-cleanup-attempt-recorded',
                                    operationId: id,
                                    reservationTransactionId: reservation.transactionId,
                                    removalTransactionId: before.binding.completion.transactionId,
                                  });
                                  expect(result.attemptId).toMatch(/^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/);
                                  expect(Object.isFrozen(result)).toBe(true);
                                  const after = (await fenceJournal.model.findOne()).getDataValue('payload');
                                  expect(after.binding).toEqual(before.binding);
                                  expect(after.attempt).toEqual({
                                    schemaVersion: 1,
                                    kind: 'attachment-removal-cleanup-attempt',
                                    state: 'unresolved',
                                    operationId: id,
                                    attemptId: result.attemptId,
                                    transactionId: result.transactionId,
                                    reservation: before.binding,
                                  });
                                  expect(result.transactionId).not.toBe(reservation.transactionId);
                                  expect(result.transactionId).not.toBe(before.binding.completion.transactionId);
                                  const [rows] = await db.sequelize.query(
                                    'SELECT pg_xact_status($xid::xid8) AS status',
                                    { bind: { xid: result.transactionId } },
                                  );
                                  expect(rows).toEqual([{ status: 'committed' }]);
                                  expect(await fs.readFile(location())).toEqual(bytes);
                                } finally {
                                  await other.db.close();
                                }
                              });

                              it('does not replace or retry a recorded attempt from a new inspector pool', async () => {
                                const { id } = await reserved();
                                const first = await coordinated();
                                try {
                                  await first.inspector.recordLocalCleanupAttempt(id);
                                } finally {
                                  await first.db.close();
                                }
                                const [before] = await db.sequelize.query(
                                  'SELECT xmin::text,ctid::text,payload FROM verified_reference_fence',
                                );
                                const second = await coordinated();
                                try {
                                  await expect(second.inspector.recordLocalCleanupAttempt(id)).rejects.toThrow(
                                    'already recorded',
                                  );
                                  expect(
                                    await db.sequelize
                                      .query('SELECT xmin::text,ctid::text,payload FROM verified_reference_fence')
                                      .then(([rows]) => rows),
                                  ).toEqual(before);
                                  expect(await fs.readFile(location())).toEqual(bytes);
                                } finally {
                                  await second.db.close();
                                }
                              });

                              it('preserves ordinary reservation inspection as non-updating after an attempt exists', async () => {
                                const { id, reservation } = await reserved();
                                const first = await coordinated();
                                try {
                                  await first.inspector.recordLocalCleanupAttempt(id);
                                } finally {
                                  await first.db.close();
                                }
                                const [before] = await db.sequelize.query(
                                  'SELECT xmin::text,ctid::text,payload FROM verified_reference_fence',
                                );
                                const other = await coordinated();
                                try {
                                  expect(await other.inspector.inspectReferenceReservation(id)).toMatchObject({
                                    state: 'committed-reference-reservation-observed',
                                    operationId: id,
                                    transactionId: reservation.transactionId,
                                  });
                                  const [after] = await db.sequelize.query(
                                    'SELECT xmin::text,ctid::text,payload FROM verified_reference_fence',
                                  );
                                  expect(after).toEqual(before);
                                } finally {
                                  await other.db.close();
                                }
                              });

                              it.each(['open', 'bare'])('does not turn an %s fence into an attempt', async (kind) => {
                                const id = await unreferenced();
                                if (kind === 'bare')
                                  await db.sequelize.transaction(
                                    { isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE },
                                    (tx) => fence.reserve(id, tx),
                                  );
                                const other = await coordinated();
                                try {
                                  expect(await other.inspector.recordLocalCleanupAttempt(id)).toEqual({
                                    state: 'unknown',
                                  });
                                  expect(
                                    (await fenceJournal.model.findOne()).getDataValue('payload'),
                                  ).not.toHaveProperty('attempt');
                                } finally {
                                  await other.db.close();
                                }
                              });

                              it('keeps another operation unknown instead of borrowing an existing reservation', async () => {
                                await reserved();
                                const other = await coordinated();
                                try {
                                  expect(
                                    await other.inspector.recordLocalCleanupAttempt(
                                      '11111111-1111-1111-1111-111111111111',
                                    ),
                                  ).toEqual({ state: 'unknown' });
                                  expect(
                                    (await fenceJournal.model.findOne()).getDataValue('payload'),
                                  ).not.toHaveProperty('attempt');
                                } finally {
                                  await other.db.close();
                                }
                              });

                              it.each([
                                { fields: ['event', 'oid'], value: '1' },
                                { fields: ['objectBinding', 'object', 'object', 'size'], value: '999' },
                              ])(
                                'refuses altered stored evidence before recording an attempt: $fields',
                                async ({ fields, value }) => {
                                  const { id } = await reserved();
                                  await changeBinding(fields, value);
                                  const other = await coordinated();
                                  try {
                                    await expect(other.inspector.recordLocalCleanupAttempt(id)).rejects.toThrow();
                                    expect(
                                      (await fenceJournal.model.findOne()).getDataValue('payload'),
                                    ).not.toHaveProperty('attempt');
                                    expect(await fs.readFile(location())).toEqual(bytes);
                                  } finally {
                                    await other.db.close();
                                  }
                                },
                              );

                              it('rejects a current file replacement without writing any attempt', async () => {
                                const { id } = await reserved();
                                await fs.rename(location(), `${location()}.original`);
                                await fs.writeFile(location(), bytes);
                                const other = await coordinated();
                                try {
                                  await expect(other.inspector.recordLocalCleanupAttempt(id)).rejects.toThrow(
                                    'Removal reference object changed',
                                  );
                                  expect(
                                    (await fenceJournal.model.findOne()).getDataValue('payload'),
                                  ).not.toHaveProperty('attempt');
                                  expect(await fs.readFile(`${location()}.original`)).toEqual(bytes);
                                } finally {
                                  await other.db.close();
                                }
                              });

                              it.each(['throw', 'replace object'])(
                                'rolls back the actual attempt UPDATE after a write-time %s',
                                async (failure) => {
                                  const { id } = await reserved();
                                  const before = (await fenceJournal.model.findOne()).getDataValue('payload');
                                  const other = await coordinated();
                                  let changed = false;
                                  other.db.sequelize.addHook(
                                    'afterQuery',
                                    'interrupt-cleanup-attempt',
                                    async (_options, query) => {
                                      const sql = (query as unknown as { sql: string }).sql;
                                      if (
                                        !changed &&
                                        sql.startsWith('UPDATE ') &&
                                        sql.includes('attachment-removal-cleanup-attempt')
                                      ) {
                                        changed = true;
                                        if (failure === 'throw') throw new Error('abort after attempt SQL');
                                        await fs.rename(location(), `${location()}.original`);
                                        await fs.writeFile(location(), bytes);
                                      }
                                    },
                                  );
                                  try {
                                    await expect(other.inspector.recordLocalCleanupAttempt(id)).rejects.toThrow();
                                    expect(changed).toBe(true);
                                    expect((await fenceJournal.model.findOne()).getDataValue('payload')).toEqual(
                                      before,
                                    );
                                    expect(
                                      await fs.readFile(failure === 'throw' ? location() : `${location()}.original`),
                                    ).toEqual(bytes);
                                  } finally {
                                    other.db.sequelize.removeHook('afterQuery', 'interrupt-cleanup-attempt');
                                    await other.db.close();
                                  }
                                },
                              );

                              it('retains the unresolved attempt after a real afterCommit failure and refuses a second attempt', async () => {
                                const { id } = await reserved();
                                const first = await coordinated();
                                let registered = false;
                                first.db.sequelize.addHook('afterQuery', 'attempt-after-commit', (options, query) => {
                                  const sql = (query as unknown as { sql: string }).sql;
                                  if (
                                    !registered &&
                                    sql.startsWith('UPDATE ') &&
                                    sql.includes('attachment-removal-cleanup-attempt')
                                  ) {
                                    registered = true;
                                    (options as { transaction: Transaction }).transaction.afterCommit(() => {
                                      throw new Error('actual attempt afterCommit failure');
                                    });
                                  }
                                });
                                try {
                                  await expect(first.inspector.recordLocalCleanupAttempt(id)).rejects.toThrow(
                                    'actual attempt afterCommit failure',
                                  );
                                  expect(registered).toBe(true);
                                } finally {
                                  first.db.sequelize.removeHook('afterQuery', 'attempt-after-commit');
                                  await first.db.close();
                                }
                                const before = (await fenceJournal.model.findOne()).getDataValue('payload');
                                expect(before.attempt.state).toBe('unresolved');
                                const [status] = await db.sequelize.query(
                                  'SELECT pg_xact_status($xid::xid8) AS status',
                                  { bind: { xid: before.attempt.transactionId } },
                                );
                                expect(status).toEqual([{ status: 'committed' }]);
                                const second = await coordinated();
                                try {
                                  await expect(second.inspector.recordLocalCleanupAttempt(id)).rejects.toThrow(
                                    'already recorded',
                                  );
                                  expect((await fenceJournal.model.findOne()).getDataValue('payload')).toEqual(before);
                                  expect(await fs.readFile(location())).toEqual(bytes);
                                } finally {
                                  await second.db.close();
                                }
                              });

                              it('allows at most one actual attempt across two independent inspector pools', async () => {
                                const { id } = await reserved();
                                const first = await coordinated();
                                const second = await coordinated();
                                try {
                                  const results = await Promise.allSettled([
                                    first.inspector.recordLocalCleanupAttempt(id),
                                    second.inspector.recordLocalCleanupAttempt(id),
                                  ]);
                                  expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
                                  expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
                                  const winner = results.find(
                                    ({ status }) => status === 'fulfilled',
                                  ) as PromiseFulfilledResult<files.AttachmentRemovalCleanupAttemptRecord>;
                                  expect(winner.value.state).toBe('committed-cleanup-attempt-recorded');
                                  if (winner.value.state !== 'committed-cleanup-attempt-recorded')
                                    throw new Error('expected committed attempt');
                                  expect(
                                    (await fenceJournal.model.findOne()).getDataValue('payload').attempt.attemptId,
                                  ).toBe(winner.value.attemptId);
                                  expect(await fs.readFile(location())).toEqual(bytes);
                                } finally {
                                  await first.db.close();
                                  await second.db.close();
                                }
                              });

                              it.each([
                                'state',
                                'extra',
                                'operation',
                                'reservation xid',
                                'removal xid',
                                'binding',
                                'null',
                              ])('rejects a malformed stored attempt without updating it: %s', async (kind) => {
                                const { id } = await reserved();
                                const first = await coordinated();
                                try {
                                  await first.inspector.recordLocalCleanupAttempt(id);
                                } finally {
                                  await first.db.close();
                                }
                                const payload = (await fenceJournal.model.findOne()).getDataValue('payload');
                                const attempt = payload.attempt;
                                if (kind === 'state') attempt.state = 'completed';
                                if (kind === 'extra') attempt.permit = true;
                                if (kind === 'operation') attempt.operationId = '11111111-1111-1111-1111-111111111111';
                                if (kind === 'reservation xid') attempt.transactionId = payload.binding.transactionId;
                                if (kind === 'removal xid')
                                  attempt.transactionId = payload.binding.completion.transactionId;
                                if (kind === 'binding') attempt.reservation.event.oid = '1';
                                await db.sequelize.query(
                                  `UPDATE verified_reference_fence SET payload=jsonb_set(payload,'{attempt}',$value::jsonb)`,
                                  { bind: { value: JSON.stringify(kind === 'null' ? null : attempt) } },
                                );
                                const [before] = await db.sequelize.query(
                                  'SELECT xmin::text,ctid::text,payload FROM verified_reference_fence',
                                );
                                const other = await coordinated();
                                try {
                                  await expect(other.inspector.inspectReferenceReservation(id)).rejects.toThrow(
                                    'cleanup attempt is invalid',
                                  );
                                  await expect(other.inspector.recordLocalCleanupAttempt(id)).rejects.toThrow(
                                    'cleanup attempt is invalid',
                                  );
                                  const [after] = await db.sequelize.query(
                                    'SELECT xmin::text,ctid::text,payload FROM verified_reference_fence',
                                  );
                                  expect(after).toEqual(before);
                                  expect(await fs.readFile(location())).toEqual(bytes);
                                } finally {
                                  await other.db.close();
                                }
                              });

                              it('does not reuse a recorded attempt after its old path is replaced', async () => {
                                const { id } = await reserved();
                                const first = await coordinated();
                                try {
                                  await first.inspector.recordLocalCleanupAttempt(id);
                                } finally {
                                  await first.db.close();
                                }
                                const before = (await fenceJournal.model.findOne()).getDataValue('payload');
                                await fs.rename(location(), `${location()}.original`);
                                const replacement = Buffer.from('A distinct object at a reused old name');
                                await fs.writeFile(location(), replacement);
                                const other = await coordinated();
                                try {
                                  await expect(other.inspector.recordLocalCleanupAttempt(id)).rejects.toThrow(
                                    'Removal reference object changed',
                                  );
                                  expect((await fenceJournal.model.findOne()).getDataValue('payload')).toEqual(before);
                                  expect(await fs.readFile(location())).toEqual(replacement);
                                  expect(await fs.readFile(`${location()}.original`)).toEqual(bytes);
                                } finally {
                                  await other.db.close();
                                }
                              });

                              it('requires an explicitly configured independent reference fence', async () => {
                                const { id } = await reserved();
                                const other = await references();
                                try {
                                  await expect(other.inspector.recordLocalCleanupAttempt(id)).rejects.toThrow(
                                    'explicit independent fence',
                                  );
                                } finally {
                                  await other.db.close();
                                }
                              });
                            });

                            describe('independent durable cleanup attempt inspection', () => {
                              const attempted = async () => {
                                const { id } = await reserved();
                                const other = await coordinated();
                                try {
                                  const recorded = await other.inspector.recordLocalCleanupAttempt(id);
                                  return { id, recorded };
                                } finally {
                                  await other.db.close();
                                }
                              };
                              const fenceState = () =>
                                db.sequelize
                                  .query('SELECT xmin::text,ctid::text,payload FROM verified_reference_fence')
                                  .then(([rows]) => rows);

                              it('independently observes the committed attempt without updating stored rows or returning a path', async () => {
                                const { id, recorded } = await attempted();
                                const before = await fenceState();
                                const other = await coordinated();
                                try {
                                  const seen = await other.inspector.inspectLocalCleanupAttempt(id);
                                  expect(seen).toEqual({
                                    state: 'committed-cleanup-attempt-observed',
                                    operationId: id,
                                    attemptId: recorded.attemptId,
                                    transactionId: recorded.transactionId,
                                    reservationTransactionId: recorded.reservationTransactionId,
                                    removalTransactionId: recorded.removalTransactionId,
                                  });
                                  expect(Object.isFrozen(seen)).toBe(true);
                                  expect(await fenceState()).toEqual(before);
                                  expect(await fs.readFile(location())).toEqual(bytes);
                                } finally {
                                  await other.db.close();
                                }
                              });

                              it.each(['open', 'bare', 'reserved'])(
                                'keeps an %s state without an attempt unknown',
                                async (kind) => {
                                  const id = kind === 'reserved' ? (await reserved()).id : await unreferenced();
                                  if (kind === 'bare')
                                    await db.sequelize.transaction(
                                      { isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE },
                                      (tx) => fence.reserve(id, tx),
                                    );
                                  const before = await fenceState();
                                  const other = await coordinated();
                                  try {
                                    expect(await other.inspector.inspectLocalCleanupAttempt(id)).toEqual({
                                      state: 'unknown',
                                    });
                                    expect(await fenceState()).toEqual(before);
                                  } finally {
                                    await other.db.close();
                                  }
                                },
                              );

                              it('does not borrow another operation attempt', async () => {
                                await attempted();
                                const before = await fenceState();
                                const other = await coordinated();
                                try {
                                  expect(
                                    await other.inspector.inspectLocalCleanupAttempt(
                                      '11111111-1111-1111-1111-111111111111',
                                    ),
                                  ).toEqual({ state: 'unknown' });
                                  expect(await fenceState()).toEqual(before);
                                } finally {
                                  await other.db.close();
                                }
                              });

                              it.each(['missing', 'reused'])(
                                'reports historical commit without opening an old %s path or changing either object',
                                async (kind) => {
                                  const { id, recorded } = await attempted();
                                  await fs.rename(location(), `${location()}.original`);
                                  const replacement = Buffer.from('Unrelated replacement at a reused pathname');
                                  if (kind === 'reused') await fs.writeFile(location(), replacement);
                                  const before = await fenceState();
                                  const other = await coordinated();
                                  try {
                                    expect(await other.inspector.inspectLocalCleanupAttempt(id)).toMatchObject({
                                      state: 'committed-cleanup-attempt-observed',
                                      attemptId: recorded.attemptId,
                                    });
                                    expect(await fenceState()).toEqual(before);
                                    expect(await fs.readFile(`${location()}.original`)).toEqual(bytes);
                                    if (kind === 'reused') expect(await fs.readFile(location())).toEqual(replacement);
                                    else await expect(fs.stat(location())).rejects.toMatchObject({ code: 'ENOENT' });
                                  } finally {
                                    await other.db.close();
                                  }
                                },
                              );

                              it.each(['active', 'aborted', 'future'])(
                                'refuses a stored attempt xid whose actual status is %s',
                                async (kind) => {
                                  const { id } = await attempted();
                                  const tx = await db.sequelize.transaction({
                                    isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE,
                                  });
                                  let finished = false;
                                  try {
                                    const [rows] = await db.sequelize.query('SELECT txid_current()::text AS xid', {
                                      transaction: tx,
                                    });
                                    let xid = (rows as { xid: string }[])[0].xid;
                                    if (kind === 'aborted') {
                                      await tx.rollback();
                                      finished = true;
                                    }
                                    if (kind === 'future') {
                                      await tx.rollback();
                                      finished = true;
                                      xid = String(BigInt(xid) + 1000000n);
                                    }
                                    await db.sequelize.query(
                                      `UPDATE verified_reference_fence SET payload=jsonb_set(payload,'{attempt,transactionId}',to_jsonb($xid::text))`,
                                      { bind: { xid } },
                                    );
                                    const before = await fenceState();
                                    const other = await coordinated();
                                    try {
                                      await expect(other.inspector.inspectLocalCleanupAttempt(id)).rejects.toThrow();
                                      expect(await fenceState()).toEqual(before);
                                      expect(await fs.readFile(location())).toEqual(bytes);
                                    } finally {
                                      await other.db.close();
                                    }
                                  } finally {
                                    if (!finished) await tx.rollback();
                                  }
                                },
                              );

                              it('rejects its own observing xid and rolls back the same-transaction injected update', async () => {
                                const { id } = await attempted();
                                const before = await fenceState();
                                const other = await coordinated();
                                let changed = false;
                                other.db.sequelize.addHook('afterQuery', 'attempt-own-xid', async (options, query) => {
                                  const sql = (query as unknown as { sql: string }).sql;
                                  if (!changed && sql.includes('pg_catalog.txid_current()::text AS xid,')) {
                                    changed = true;
                                    await other.db.sequelize.query(
                                      `UPDATE verified_reference_fence SET payload=jsonb_set(payload,'{attempt,transactionId}',to_jsonb(txid_current()::text))`,
                                      { transaction: (options as { transaction: Transaction }).transaction },
                                    );
                                  }
                                });
                                try {
                                  await expect(other.inspector.inspectLocalCleanupAttempt(id)).rejects.toThrow(
                                    'observing transaction',
                                  );
                                  expect(changed).toBe(true);
                                  expect(await fenceState()).toEqual(before);
                                } finally {
                                  other.db.sequelize.removeHook('afterQuery', 'attempt-own-xid');
                                  await other.db.close();
                                }
                              });

                              it.each([
                                { fields: ['event', 'oid'], value: '1' },
                                { fields: ['objectBinding', 'object', 'object', 'size'], value: '999' },
                              ])(
                                'does not accept matching copied reservation/attempt claims instead of actual evidence: $fields',
                                async ({ fields, value }) => {
                                  const { id } = await attempted();
                                  await changeBinding(fields, value);
                                  await db.sequelize.query(
                                    `UPDATE verified_reference_fence SET payload=jsonb_set(payload,'{attempt,reservation}',payload->'binding')`,
                                  );
                                  const before = await fenceState();
                                  const other = await coordinated();
                                  try {
                                    await expect(other.inspector.inspectLocalCleanupAttempt(id)).rejects.toThrow();
                                    expect(await fenceState()).toEqual(before);
                                    expect(await fs.readFile(location())).toEqual(bytes);
                                  } finally {
                                    await other.db.close();
                                  }
                                },
                              );

                              it.each(['completion', 'object', 'native event'])(
                                'rejects an existing attempt with missing actual %s evidence',
                                async (kind) => {
                                  const { id } = await attempted();
                                  const table = kind === 'completion' ? intents : kind === 'object' ? objects : events;
                                  await table.model.destroy({ where: { id }, hooks: false });
                                  const before = await fenceState();
                                  const other = await coordinated();
                                  try {
                                    await expect(other.inspector.inspectLocalCleanupAttempt(id)).rejects.toThrow();
                                    expect(await fenceState()).toEqual(before);
                                  } finally {
                                    await other.db.close();
                                  }
                                },
                              );

                              it('rechecks the exact attempt after reading its committed status and rolls back evidence drift', async () => {
                                const { id, recorded } = await attempted();
                                const before = await fenceState();
                                const other = await coordinated();
                                let changed = false;
                                other.db.sequelize.addHook(
                                  'afterQuery',
                                  'attempt-read-drift',
                                  async (options, query) => {
                                    const sql = (query as unknown as { sql: string }).sql;
                                    if (
                                      !changed &&
                                      sql.includes('pg_catalog.pg_xact_status(') &&
                                      (options as { bind?: { xid?: string } }).bind?.xid === recorded.transactionId
                                    ) {
                                      changed = true;
                                      await other.db.sequelize.query(
                                        `UPDATE verified_reference_fence SET payload=jsonb_set(payload,'{attempt,attemptId}',to_jsonb($id::text))`,
                                        {
                                          transaction: (options as { transaction: Transaction }).transaction,
                                          bind: { id: '22222222-2222-2222-2222-222222222222' },
                                        },
                                      );
                                    }
                                  },
                                );
                                try {
                                  await expect(other.inspector.inspectLocalCleanupAttempt(id)).rejects.toThrow(
                                    'attempt evidence changed',
                                  );
                                  expect(changed).toBe(true);
                                  expect(await fenceState()).toEqual(before);
                                } finally {
                                  other.db.sequelize.removeHook('afterQuery', 'attempt-read-drift');
                                  await other.db.close();
                                }
                              });

                              it('observes an unresolved attempt after a real afterCommit failure without authorizing a retry', async () => {
                                const { id } = await reserved();
                                const first = await coordinated();
                                let registered = false;
                                first.db.sequelize.addHook(
                                  'afterQuery',
                                  'inspect-attempt-after-commit',
                                  (options, query) => {
                                    const sql = (query as unknown as { sql: string }).sql;
                                    if (
                                      !registered &&
                                      sql.startsWith('UPDATE ') &&
                                      sql.includes('attachment-removal-cleanup-attempt')
                                    ) {
                                      registered = true;
                                      (options as { transaction: Transaction }).transaction.afterCommit(() => {
                                        throw new Error('actual observed attempt afterCommit failure');
                                      });
                                    }
                                  },
                                );
                                try {
                                  await expect(first.inspector.recordLocalCleanupAttempt(id)).rejects.toThrow(
                                    'actual observed attempt afterCommit failure',
                                  );
                                  expect(registered).toBe(true);
                                } finally {
                                  first.db.sequelize.removeHook('afterQuery', 'inspect-attempt-after-commit');
                                  await first.db.close();
                                }
                                const before = await fenceState();
                                const stored = (await fenceJournal.model.findOne()).getDataValue('payload').attempt;
                                const other = await coordinated();
                                try {
                                  expect(await other.inspector.inspectLocalCleanupAttempt(id)).toMatchObject({
                                    state: 'committed-cleanup-attempt-observed',
                                    attemptId: stored.attemptId,
                                    transactionId: stored.transactionId,
                                  });
                                  await expect(other.inspector.recordLocalCleanupAttempt(id)).rejects.toThrow(
                                    'already recorded',
                                  );
                                  expect(await fenceState()).toEqual(before);
                                  expect(stored.state).toBe('unresolved');
                                  expect(await fs.readFile(location())).toEqual(bytes);
                                } finally {
                                  await other.db.close();
                                }
                              });

                              it('keeps historical attempt observation separate from current reference clearance', async () => {
                                const { id, recorded } = await attempted();
                                // This privileged isolated fixture simulates a writer outside the declared fence contract.
                                const guard = fence.functionName.split('.').at(-1);
                                await db.sequelize.query('ALTER TABLE documents DISABLE TRIGGER ' + guard);
                                try {
                                  await docs.model.create(
                                    {
                                      id: 9,
                                      path: 'old/tenants/H',
                                      filename: 'receipt.txt',
                                      storageId: 18,
                                      size: bytes.length,
                                    },
                                    { hooks: false },
                                  );
                                } finally {
                                  await db.sequelize.query('ALTER TABLE documents ENABLE ALWAYS TRIGGER ' + guard);
                                }
                                const before = await fenceState();
                                const other = await coordinated();
                                try {
                                  expect(await other.inspector.inspectLocalCleanupAttempt(id)).toMatchObject({
                                    state: 'committed-cleanup-attempt-observed',
                                    attemptId: recorded.attemptId,
                                  });
                                  await expect(other.inspector.inspectReferenceReservation(id)).rejects.toThrow(
                                    'requires zero mapped references',
                                  );
                                  expect(await docs.model.count()).toBe(1);
                                  expect(await fenceState()).toEqual(before);
                                  expect(await fs.readFile(location())).toEqual(bytes);
                                } finally {
                                  await other.db.close();
                                }
                              });

                              it.each([
                                'null',
                                'done',
                                'same operation',
                                'same removal xid',
                                'same reservation xid',
                                'number xid',
                                'extra field',
                              ])('refuses malformed stored attempt %s without updating it', async (kind) => {
                                const { id } = await attempted();
                                const payload = (await fenceJournal.model.findOne()).getDataValue('payload');
                                if (kind === 'null') payload.attempt = null;
                                else if (kind === 'done') payload.attempt.state = 'done';
                                else if (kind === 'same operation') payload.attempt.attemptId = id;
                                else if (kind === 'same removal xid')
                                  payload.attempt.transactionId = payload.binding.completion.transactionId;
                                else if (kind === 'same reservation xid')
                                  payload.attempt.transactionId = payload.binding.transactionId;
                                else if (kind === 'number xid')
                                  payload.attempt.transactionId = Number(payload.attempt.transactionId);
                                else payload.attempt.permission = 'delete';
                                await db.sequelize.query('UPDATE verified_reference_fence SET payload=$value::jsonb', {
                                  bind: { value: JSON.stringify(payload) },
                                });
                                const before = await fenceState();
                                const other = await coordinated();
                                try {
                                  await expect(other.inspector.inspectLocalCleanupAttempt(id)).rejects.toThrow();
                                  expect(await fenceState()).toEqual(before);
                                  expect(await fs.readFile(location())).toEqual(bytes);
                                } finally {
                                  await other.db.close();
                                }
                              });

                              describe('actual staged writer isolation boundaries', () => {
                                const incoming = async () => {
                                  const input = path.join(directory, 'new-upload-input.txt');
                                  const content = Buffer.from('New upload fixture, never the original attachment');
                                  await fs.writeFile(input, content);
                                  const storage = (await db.getCollection('storages').model.findByPk(18)).toJSON();
                                  return {
                                    content,
                                    storage,
                                    file: {
                                      path: input,
                                      originalname: 'incoming.txt',
                                      mimetype: 'text/plain',
                                      size: content.length,
                                    },
                                  };
                                };

                                it('can write and discard a fresh staged object while the database cleanup attempt remains fenced', async () => {
                                  await attempted();
                                  const before = await fenceState();
                                  const { content, storage, file } = await incoming();
                                  const plan = await files.prepareStagedAttachmentStorage(storage, file);
                                  const destination = path.join(root, plan.values.path, plan.values.filename);
                                  try {
                                    await plan.storeForTransaction!();
                                    expect(await fs.readFile(destination)).toEqual(content);
                                    expect(await docs.model.count()).toBe(0);
                                    expect(await fenceState()).toEqual(before);
                                    expect(await fs.readFile(location())).toEqual(bytes);
                                  } finally {
                                    // Discard belongs only to this newly created upload fixture, never the old attachment.
                                    await plan.discard();
                                  }
                                  await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
                                  expect(await fenceState()).toEqual(before);
                                  expect(await fs.readFile(location())).toEqual(bytes);
                                });

                                it('copies fresh bytes before a real fenced repository write and discards only that new object after rollback', async () => {
                                  await attempted();
                                  const before = await fenceState();
                                  const { content, storage, file } = await incoming();
                                  let destination: string | undefined;
                                  let copied = false;
                                  await expect(
                                    files.withStagedAttachmentTransaction(db, storage, file, async (input) => {
                                      await input.store();
                                      destination = path.join(root, input.values.path, input.values.filename);
                                      expect(await fs.readFile(destination)).toEqual(content);
                                      copied = true;
                                      await db.getRepository('documents').create({
                                        values: { id: 9, tenantId: 'B', ...input.values },
                                        transaction: input.transaction,
                                      });
                                    }),
                                  ).rejects.toThrow('Attachment removal reference writes are fenced');
                                  expect(copied).toBe(true);
                                  await expect(fs.stat(destination!)).rejects.toMatchObject({ code: 'ENOENT' });
                                  expect(await docs.model.count()).toBe(0);
                                  expect(await fenceState()).toEqual(before);
                                  expect(await fs.readFile(location())).toEqual(bytes);
                                });
                              });

                              it('requires an explicit independent fence mapping even for historical attempt inspection', async () => {
                                const { id } = await attempted();
                                const other = await references();
                                try {
                                  await expect(other.inspector.inspectLocalCleanupAttempt(id)).rejects.toThrow(
                                    'explicit independent fence',
                                  );
                                } finally {
                                  await other.db.close();
                                }
                              });
                            });

                            it('independently observes both committed transactions without updating the durable row or bytes', async () => {
                              const { id, reservation } = await reserved();
                              const [before] = await db.sequelize.query(
                                'SELECT xmin::text,ctid::text,payload FROM verified_reference_fence',
                              );
                              const other = await coordinated();
                              try {
                                const completion = (await intents.model.findByPk(id)).getDataValue('payload');
                                const seen = await other.inspector.inspectReferenceReservation(id);
                                expect(seen).toEqual({
                                  state: 'committed-reference-reservation-observed',
                                  operationId: id,
                                  transactionId: reservation.transactionId,
                                  removalTransactionId: completion.transactionId,
                                });
                                expect(Object.isFrozen(seen)).toBe(true);
                                expect(seen.transactionId).not.toBe(seen.removalTransactionId);
                                const [after] = await db.sequelize.query(
                                  'SELECT xmin::text,ctid::text,payload FROM verified_reference_fence',
                                );
                                expect(after).toEqual(before);
                                expect(await fs.readFile(location())).toEqual(bytes);
                                await expect(docs.repository.create({ values: { id: 9 } })).rejects.toThrow(
                                  'Attachment removal reference writes are fenced',
                                );
                              } finally {
                                await other.db.close();
                              }
                            });

                            it.each(['open', 'bare'])(
                              'keeps an %s fence unknown rather than promoting its UUID',
                              async (state) => {
                                const id = await unreferenced();
                                if (state === 'bare')
                                  await db.sequelize.transaction(
                                    { isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE },
                                    (tx) => fence.reserve(id, tx),
                                  );
                                const other = await coordinated();
                                try {
                                  expect(await other.inspector.inspectReferenceReservation(id)).toEqual({
                                    state: 'unknown',
                                  });
                                  expect(
                                    await other.inspector.inspectReferenceReservation(
                                      '11111111-1111-1111-1111-111111111111',
                                    ),
                                  ).toEqual({ state: 'unknown' });
                                  expect(
                                    (await fenceJournal.model.findOne()).getDataValue('payload'),
                                  ).not.toHaveProperty('binding');
                                } finally {
                                  await other.db.close();
                                }
                              },
                            );

                            it.each([
                              { kind: 'completion', fields: ['completion', 'record', 'tenantId'], value: 'H' },
                              { kind: 'object', fields: ['objectBinding', 'object', 'object', 'size'], value: '999' },
                              { kind: 'event oid', fields: ['event', 'oid'], value: '1' },
                              { kind: 'event field', fields: ['event', 'payload'], value: 'another_payload' },
                              {
                                kind: 'operation',
                                fields: ['operationId'],
                                value: '11111111-1111-1111-1111-111111111111',
                              },
                              { kind: 'extra', fields: ['extra'], value: true },
                            ])('rejects durable $kind binding tampering', async ({ fields, value }) => {
                              const { id } = await reserved();
                              await changeBinding(fields, value);
                              const other = await coordinated();
                              try {
                                await expect(other.inspector.inspectReferenceReservation(id)).rejects.toThrow(
                                  /Removal reference/,
                                );
                                expect(await fs.readFile(location())).toEqual(bytes);
                              } finally {
                                await other.db.close();
                              }
                            });

                            it.each(['active', 'aborted', 'original', 'future', 'invalid'])(
                              'rejects a %s coordinating transaction',
                              async (kind) => {
                                const { id } = await reserved();
                                let active: Transaction | undefined;
                                let xid: string;
                                if (kind === 'original')
                                  xid = (await intents.model.findByPk(id)).getDataValue('payload').transactionId;
                                else if (kind === 'future') xid = '18446744073709551615';
                                else if (kind === 'invalid') xid = '0';
                                else {
                                  active = await db.sequelize.transaction();
                                  const [rows] = await db.sequelize.query('SELECT txid_current()::text AS xid', {
                                    transaction: active,
                                  });
                                  xid = (rows as { xid: string }[])[0].xid;
                                  if (kind === 'aborted') {
                                    await active.rollback();
                                    active = undefined;
                                  }
                                }
                                await changeBinding(['transactionId'], xid);
                                const other = await coordinated();
                                try {
                                  await expect(other.inspector.inspectReferenceReservation(id)).rejects.toThrow();
                                  expect(await fs.readFile(location())).toEqual(bytes);
                                } finally {
                                  if (active) await active.rollback();
                                  await other.db.close();
                                }
                              },
                            );

                            it.each(['completion', 'object'])(
                              'rejects a bound reservation with missing actual %s evidence',
                              async (kind) => {
                                const { id } = await reserved();
                                await (kind === 'completion' ? intents : objects).model.destroy({
                                  where: { id },
                                  hooks: false,
                                });
                                const other = await coordinated();
                                try {
                                  await expect(other.inspector.inspectReferenceReservation(id)).rejects.toThrow(
                                    /Removal reference reservation/,
                                  );
                                  expect(await fs.readFile(location())).toEqual(bytes);
                                } finally {
                                  await other.db.close();
                                }
                              },
                            );

                            it('requires explicit fence configuration instead of falling back to ordinary inspection', async () => {
                              const { id } = await reserved();
                              const other = await references();
                              try {
                                await expect(other.inspector.inspectReferenceReservation(id)).rejects.toThrow(
                                  'Reference reservation inspection requires an explicit independent fence mapping',
                                );
                              } finally {
                                await other.db.close();
                              }
                            });

                            it('rereads the locked binding after the actual evidence checks and rolls back timing-hook changes', async () => {
                              const { id } = await reserved();
                              const before = (await fenceJournal.model.findOne()).getDataValue('payload');
                              const other = await coordinated();
                              let changed = false;
                              other.db.sequelize.addHook(
                                'afterQuery',
                                'change-after-binding-read',
                                async (options, query) => {
                                  if (
                                    !changed &&
                                    (query as unknown as { sql: string }).sql.startsWith(
                                      'SELECT "payload" AS payload FROM "public"."verified_reference_fence"',
                                    )
                                  ) {
                                    changed = true;
                                    await other.db.sequelize.query(
                                      `UPDATE verified_reference_fence SET payload=jsonb_set(payload,'{binding,completion,record,tenantId}','"H"'::jsonb)`,
                                      { transaction: options.transaction },
                                    );
                                  }
                                },
                              );
                              try {
                                await expect(other.inspector.inspectReferenceReservation(id)).rejects.toThrow(
                                  'Removal reference reservation evidence changed',
                                );
                                expect(changed).toBe(true);
                                expect((await fenceJournal.model.findOne()).getDataValue('payload')).toEqual(before);
                              } finally {
                                other.db.sequelize.removeHook('afterQuery', 'change-after-binding-read');
                                await other.db.close();
                              }
                            });

                            it('rejects the observing transaction as the recorded coordinator', async () => {
                              const { id } = await reserved();
                              const other = await coordinated();
                              let changed = false;
                              other.db.sequelize.addHook(
                                'afterQuery',
                                'replace-coordinator-with-observer',
                                async (options, query) => {
                                  if (
                                    !changed &&
                                    (query as unknown as { sql: string }).sql.startsWith(
                                      'SELECT pg_catalog.current_database()',
                                    )
                                  ) {
                                    changed = true;
                                    await other.db.sequelize.query(
                                      `UPDATE verified_reference_fence SET payload=jsonb_set(payload,'{binding,transactionId}',to_jsonb(txid_current()::text))`,
                                      { transaction: options.transaction },
                                    );
                                  }
                                },
                              );
                              try {
                                await expect(other.inspector.inspectReferenceReservation(id)).rejects.toThrow(
                                  /Removal reference/,
                                );
                                expect(changed).toBe(true);
                              } finally {
                                other.db.sequelize.removeHook('afterQuery', 'replace-coordinator-with-observer');
                                await other.db.close();
                              }
                            });

                            it('refuses a same-name replacement of the physical fence table', async () => {
                              const { id } = await reserved();
                              await db.sequelize.query(
                                'ALTER TABLE verified_reference_fence RENAME TO original_reference_fence',
                              );
                              await fenceJournal.model.sync();
                              await db.sequelize.query(
                                'INSERT INTO verified_reference_fence SELECT * FROM original_reference_fence',
                              );
                              const other = await coordinated();
                              try {
                                await expect(other.inspector.inspectReferenceReservation(id)).rejects.toThrow(
                                  /Removal reference/,
                                );
                              } finally {
                                await other.db.close();
                                await db.sequelize.query('DROP TABLE verified_reference_fence');
                                await db.sequelize.query(
                                  'ALTER TABLE original_reference_fence RENAME TO verified_reference_fence',
                                );
                              }
                            });

                            it('rejects current filesystem replacement despite a committed reservation', async () => {
                              const { id } = await reserved();
                              await fs.rename(location(), `${location()}.original`);
                              await fs.writeFile(location(), bytes);
                              const other = await coordinated();
                              try {
                                await expect(other.inspector.inspectReferenceReservation(id)).rejects.toThrow(
                                  'Removal reference object changed or is unavailable',
                                );
                                expect(await fs.readFile(`${location()}.original`)).toEqual(bytes);
                              } finally {
                                await other.db.close();
                              }
                            });

                            it('rejects a privileged fixture reintroduction instead of relying on the historical zero', async () => {
                              const { id } = await reserved();
                              // Only this isolated fixture bypasses guards to simulate an out-of-contract writer.
                              const guard = fence.functionName.split('.').at(-1);
                              await db.sequelize.query(`ALTER TABLE documents DISABLE TRIGGER ${guard}`);
                              await docs.model.create(
                                {
                                  id: 9,
                                  path: 'old/tenants/H',
                                  filename: 'receipt.txt',
                                  storageId: 18,
                                  size: bytes.length,
                                },
                                { hooks: false },
                              );
                              await db.sequelize.query(`ALTER TABLE documents ENABLE ALWAYS TRIGGER ${guard}`);
                              const other = await coordinated();
                              try {
                                await expect(other.inspector.inspectReferenceReservation(id)).rejects.toThrow(
                                  'Removal reference reservation requires zero mapped references',
                                );
                                expect(await fs.readFile(location())).toEqual(bytes);
                              } finally {
                                await other.db.close();
                              }
                            });
                          });

                          it('persists verified completion/object/event provenance and the owning transaction before fencing writes', async () => {
                            const id = await unreferenced();
                            const other = await coordinated();
                            try {
                              const seen = await other.inspector.reserveLocalReferences(id);
                              expect(seen).toMatchObject({
                                state: 'committed-reference-fence-reservation',
                                operationId: id,
                              });
                              expect(Object.isFrozen(seen)).toBe(true);
                              const payload = (await fenceJournal.model.findOne()).getDataValue('payload');
                              expect(payload.reservation).toBe(id);
                              expect(payload.binding).toMatchObject({
                                schemaVersion: 1,
                                kind: 'attachment-removal-reference-fence-binding',
                                operationId: id,
                                transactionId: seen.transactionId,
                                references: 0,
                                completion: (await intents.model.findByPk(id)).getDataValue('payload'),
                                objectBinding: (await objects.model.findByPk(id)).getDataValue('payload'),
                                event: { table: '"public"."attachment_removal_events"' },
                              });
                              const [status] = await db.sequelize.query('SELECT pg_xact_status($xid::xid8) AS status', {
                                bind: { xid: seen.transactionId },
                              });
                              expect(status).toEqual([{ status: 'committed' }]);
                              await expect(
                                docs.repository.create({
                                  values: { id: 9, storageId: 18, path: '', filename: 'new.txt' },
                                }),
                              ).rejects.toThrow('Attachment removal reference writes are fenced');
                              expect(await fs.readFile(location())).toEqual(bytes);
                            } finally {
                              await other.db.close();
                            }
                          });

                          it('refuses to reserve when another retained row references the object', async () => {
                            const result = await runBound();
                            const other = await coordinated();
                            try {
                              await expect(other.inspector.reserveLocalReferences(result.operationId)).rejects.toThrow(
                                'Removal reference reservation requires zero mapped references',
                              );
                              expect(
                                (await fenceJournal.model.findOne()).getDataValue('payload').reservation,
                              ).toBeNull();
                            } finally {
                              await other.db.close();
                            }
                          });

                          it('keeps missing operation and missing object outcomes unknown without reserving the fence', async () => {
                            const id = await unreferenced();
                            await objects.model.destroy({ where: { id } });
                            const other = await coordinated();
                            try {
                              expect(await other.inspector.reserveLocalReferences(id)).toEqual({ state: 'unknown' });
                              expect(
                                await other.inspector.reserveLocalReferences('11111111-1111-1111-1111-111111111111'),
                              ).toEqual({ state: 'unknown' });
                              expect(
                                (await fenceJournal.model.findOne()).getDataValue('payload').reservation,
                              ).toBeNull();
                            } finally {
                              await other.db.close();
                            }
                          });

                          it('refuses a deletion whose recorded storage requires retaining content', async () => {
                            await db.getCollection('storages').model.update({ paranoid: true }, { where: { id: 18 } });
                            const id = await unreferenced();
                            const other = await coordinated();
                            try {
                              await expect(other.inspector.reserveLocalReferences(id)).rejects.toThrow(
                                'Removal reference reservation cannot discard retained content',
                              );
                              expect(
                                (await fenceJournal.model.findOne()).getDataValue('payload').reservation,
                              ).toBeNull();
                            } finally {
                              await other.db.close();
                            }
                          });

                          it('rejects current object replacement before persisting a reservation', async () => {
                            const id = await unreferenced();
                            await fs.rename(location(), `${location()}.original`);
                            await fs.writeFile(location(), bytes);
                            const other = await coordinated();
                            try {
                              await expect(other.inspector.reserveLocalReferences(id)).rejects.toThrow(
                                'Removal reference object changed or is unavailable',
                              );
                              expect(
                                (await fenceJournal.model.findOne()).getDataValue('payload').reservation,
                              ).toBeNull();
                            } finally {
                              await other.db.close();
                            }
                          });

                          it('refuses a disabled native write guard and leaves the reservation open', async () => {
                            const id = await unreferenced();
                            await db.sequelize.query('ALTER TABLE documents DISABLE TRIGGER ALL');
                            const other = await coordinated();
                            try {
                              await expect(other.inspector.reserveLocalReferences(id)).rejects.toThrow(
                                'Native removal capture installation is unavailable or changed',
                              );
                              expect(
                                (await fenceJournal.model.findOne()).getDataValue('payload').reservation,
                              ).toBeNull();
                            } finally {
                              await other.db.close();
                            }
                          });

                          it('does not overwrite an already bound reservation on a second request', async () => {
                            const id = await unreferenced();
                            const other = await coordinated();
                            try {
                              await other.inspector.reserveLocalReferences(id);
                              const before = (await fenceJournal.model.findOne()).getDataValue('payload');
                              await expect(other.inspector.reserveLocalReferences(id)).rejects.toThrow(
                                'Removal reference fence is already reserved',
                              );
                              expect((await fenceJournal.model.findOne()).getDataValue('payload')).toEqual(before);
                            } finally {
                              await other.db.close();
                            }
                          });

                          it('rolls back the actually written binding and fence when the current object changes afterward', async () => {
                            const id = await unreferenced();
                            const other = await coordinated();
                            let replaced = false;
                            other.db.sequelize.addHook(
                              'afterQuery',
                              'replace-after-fence-persistence',
                              async (_options, query) => {
                                const sql = (query as unknown as { sql: string }).sql;
                                if (
                                  !replaced &&
                                  sql.startsWith('UPDATE "public"."verified_reference_fence"') &&
                                  sql.includes('"binding"')
                                ) {
                                  replaced = true;
                                  await fs.rename(location(), `${location()}.original`);
                                  await fs.writeFile(location(), bytes);
                                }
                              },
                            );
                            try {
                              await expect(other.inspector.reserveLocalReferences(id)).rejects.toThrow(
                                'Removal reference object changed or is unavailable',
                              );
                              expect(replaced).toBe(true);
                              const payload = (await fenceJournal.model.findOne()).getDataValue('payload');
                              expect(payload.reservation).toBeNull();
                              expect(payload).not.toHaveProperty('binding');
                              expect((await intents.model.findByPk(id)).getDataValue('payload').schemaVersion).toBe(3);
                              expect(await fs.readFile(`${location()}.original`)).toEqual(bytes);
                            } finally {
                              other.db.sequelize.removeHook('afterQuery', 'replace-after-fence-persistence');
                              await other.db.close();
                            }
                          });

                          it('keeps ordinary reference inspection read-only with respect to reservation state', async () => {
                            const id = await unreferenced();
                            const other = await coordinated();
                            try {
                              expect(await other.inspector.inspectLocalReferences(id)).toMatchObject({ references: 0 });
                              expect(
                                (await fenceJournal.model.findOne()).getDataValue('payload').reservation,
                              ).toBeNull();
                            } finally {
                              await other.db.close();
                            }
                          });
                        });
                        const addSource = async () => {
                          const another = db.collection({
                            ...docs.options,
                            name: 'reference_documents',
                            tableName: 'reference_documents',
                          });
                          await another.model.sync();
                          return another;
                        };

                        it('includes a reference committed while the observer waits for its scope lock', async () => {
                          const result = await runBound();
                          const other = await references();
                          const writer = await db.sequelize.transaction();
                          let pending: Promise<unknown> | undefined;
                          try {
                            const [pids] = await db.sequelize.query('SELECT pg_backend_pid() AS pid', {
                              transaction: writer,
                            });
                            const pid = (pids as { pid: number }[])[0].pid;
                            await docs.repository.create({
                              values: {
                                id: 4,
                                tenantId: 'H',
                                path: 'old/tenants/H',
                                filename: 'receipt.txt',
                                storageId: 18,
                                size: bytes.length,
                              },
                              transaction: writer,
                            });
                            pending = other.inspector.inspectLocalReferences(result.operationId);
                            void pending.catch(() => {});
                            let blocked = false;
                            for (let attempt = 0; attempt < 100; attempt++) {
                              const [rows] = await db.sequelize.query(
                                `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
                                WHERE datname=current_database() AND wait_event_type='Lock'
                                  AND $pid=ANY(pg_blocking_pids(pid))) AS blocked`,
                                { bind: { pid } },
                              );
                              if ((rows as { blocked: boolean }[])[0].blocked) {
                                blocked = true;
                                break;
                              }
                              await new Promise((resolve) => setTimeout(resolve, 20));
                            }
                            expect(blocked).toBe(true);
                            await writer.commit();
                            expect(await pending).toMatchObject({
                              state: 'committed-reference-observed',
                              references: 3,
                            });
                          } finally {
                            if (!writer.finished) await writer.rollback();
                            await pending?.catch(() => {});
                            await other.db.close();
                          }
                        });

                        it('combines committed full OLD, object binding and current references in one owned observation', async () => {
                          const result = await runBound();
                          const other = await references();
                          try {
                            const seen = await other.inspector.inspectLocalReferences(result.operationId);
                            expect(seen).toEqual({
                              state: 'committed-reference-observed',
                              operationId: result.operationId,
                              transactionId: (await intents.model.findByPk(result.operationId)).getDataValue('payload')
                                .transactionId,
                              references: 2,
                            });
                            expect(Object.isFrozen(seen)).toBe(true);
                            expect(await fs.readFile(location())).toEqual(bytes);
                          } finally {
                            await other.db.close();
                          }
                        });

                        it('observes zero mapped references after real Repository removal of the remaining rows, retaining bytes', async () => {
                          const result = await runBound();
                          await docs.repository.destroy({ filter: { id: { $in: [2, 3] } } });
                          const other = await references();
                          try {
                            expect(await other.inspector.inspectLocalReferences(result.operationId)).toMatchObject({
                              state: 'committed-reference-observed',
                              references: 0,
                            });
                            expect(await fs.readFile(location())).toEqual(bytes);
                          } finally {
                            await other.db.close();
                          }
                        });

                        it('includes another registered file collection which an actor model scope hides', async () => {
                          const another = await addSource();
                          await another.repository.create({
                            values: {
                              id: 9,
                              tenantId: 'H',
                              path: 'old/tenants/H',
                              filename: 'receipt.txt',
                              storageId: 18,
                              size: bytes.length,
                            },
                          });
                          const result = await runBound();
                          const other = await references();
                          try {
                            other.db
                              .getCollection(another.name)
                              .model.addScope('defaultScope', { where: { id: -1 } }, { override: true });
                            expect(await other.inspector.inspectLocalReferences(result.operationId)).toMatchObject({
                              state: 'committed-reference-observed',
                              references: 3,
                            });
                          } finally {
                            await other.db.close();
                          }
                        });

                        it('requires explicit complete independent reference mappings', async () => {
                          const result = await runBound();
                          const other = await observer(objects);
                          try {
                            await expect(other.inspector.inspectLocalReferences(result.operationId)).rejects.toThrow(
                              'Reference inspection requires explicit complete independent mappings',
                            );
                          } finally {
                            await other.db.close();
                          }
                        });

                        it('rejects an observer pool omitting a file source registered by the business instance', async () => {
                          await addSource();
                          let opened: Awaited<ReturnType<typeof observer>> | undefined;
                          try {
                            await expect(
                              observer(objects, [docs]).then((value) => {
                                opened = value;
                                return 'unexpectedly-created-inspector';
                              }),
                            ).rejects.toThrow('Removal reference mappings do not cover the business instance');
                          } finally {
                            await opened?.db.close();
                          }
                        });

                        it('rejects a new business mapping registered after constructing the independent inspector', async () => {
                          const result = await runBound();
                          const other = await references();
                          try {
                            await addSource();
                            await expect(other.inspector.inspectLocalReferences(result.operationId)).rejects.toThrow(
                              'Removal reference mappings changed',
                            );
                          } finally {
                            await other.db.close();
                          }
                        });

                        it('rejects business-side reference field drift even when observer metadata remains unchanged', async () => {
                          const result = await runBound();
                          const other = await references();
                          const attribute = docs.model.rawAttributes.path;
                          const original = attribute.field;
                          try {
                            attribute.field = 'changed_path';
                            await expect(other.inspector.inspectLocalReferences(result.operationId)).rejects.toThrow(
                              'Removal reference mappings changed',
                            );
                          } finally {
                            attribute.field = original;
                            await other.db.close();
                          }
                        });

                        it('keeps absent optional object evidence unknown despite a valid SQL completion', async () => {
                          const { entry } = await execution();
                          const result = await files.executeRecordedAttachmentRemoval(entry, journal, native);
                          const other = await references();
                          try {
                            expect(await other.inspector.inspectLocalReferences(result.operationId)).toEqual({
                              state: 'unknown',
                            });
                          } finally {
                            await other.db.close();
                          }
                        });

                        it('rejects a mismatched actual original intent in the bound object journal', async () => {
                          const result = await runBound();
                          const row = await objects.model.findByPk(result.operationId);
                          const payload = structuredClone(row.getDataValue('payload'));
                          payload.intent.payload.transactionId = '1';
                          await row.update({ payload });
                          const other = await references();
                          try {
                            await expect(other.inspector.inspectLocalReferences(result.operationId)).rejects.toThrow(
                              'Removal object binding is invalid or inconsistent',
                            );
                          } finally {
                            await other.db.close();
                          }
                        });

                        it('keeps historical object inspection distinct from a missing current filesystem object', async () => {
                          const result = await runBound();
                          await fs.unlink(location());
                          const other = await references();
                          try {
                            expect(await other.inspector.inspectLocalObject(result.operationId)).toMatchObject({
                              state: 'committed-object-binding-observed',
                            });
                            await expect(other.inspector.inspectLocalReferences(result.operationId)).rejects.toThrow(
                              'Removal reference object changed or is unavailable',
                            );
                          } finally {
                            await other.db.close();
                          }
                        });
                      });

                      describe('independent bound object inspection', () => {
                        it('reads the committed binding from fresh mappings and returns a detached frozen historical snapshot', async () => {
                          const stat = await fs.lstat(location(), { bigint: true });
                          const result = await runBound();
                          const other = await observer(objects);
                          try {
                            const seen = await other.inspector.inspectLocalObject(result.operationId);
                            const completed = (await intents.model.findByPk(result.operationId)).getDataValue(
                              'payload',
                            );
                            expect(seen).toMatchObject({
                              state: 'committed-object-binding-observed',
                              operationId: result.operationId,
                              transactionId: completed.transactionId,
                              object: {
                                kind: 'attachment-removal-local-object',
                                configuredRoot: root,
                                record: { key: 1, storageId: 18 },
                                object: { ino: String(stat.ino), size: String(bytes.length) },
                              },
                            });
                            if (seen.state !== 'committed-object-binding-observed')
                              throw new Error('Expected historical object evidence');
                            expect(Object.isFrozen(seen.object)).toBe(true);
                            expect(Object.isFrozen(seen.object.record)).toBe(true);
                            expect(Object.isFrozen(seen.object.object)).toBe(true);
                            expect(Object.isFrozen(seen.object.directories)).toBe(true);
                            expect(Object.isFrozen(seen.object.directories[0])).toBe(true);
                            expect(JSON.parse(JSON.stringify(seen))).toEqual(seen);
                            expect(await other.inspector.inspect(result.operationId)).toEqual({
                              state: 'committed-sql-observed',
                              operationId: result.operationId,
                              transactionId: completed.transactionId,
                            });
                            expect(await fs.readFile(location())).toEqual(bytes);
                          } finally {
                            await other.db.close();
                          }
                        });

                        it('keeps the original active transaction unknown and observes its binding only after commit', async () => {
                          docs.model.addHook('afterDestroy', async (_row, { transaction }) => {
                            const handle = await intents.model.findOne({ transaction });
                            const other = await observer(objects);
                            try {
                              expect(await other.inspector.inspectLocalObject(handle.getDataValue('id'))).toEqual({
                                state: 'unknown',
                              });
                            } finally {
                              await other.db.close();
                            }
                          });
                          const result = await runBound();
                          const other = await observer(objects);
                          try {
                            expect(await other.inspector.inspectLocalObject(result.operationId)).toMatchObject({
                              state: 'committed-object-binding-observed',
                            });
                          } finally {
                            await other.db.close();
                          }
                        });

                        it('does not infer a current filesystem object or exclusive references from a committed binding', async () => {
                          const result = await runBound();
                          await fs.unlink(location());
                          const other = await observer(objects);
                          try {
                            expect(await other.inspector.inspectLocalObject(result.operationId)).toMatchObject({
                              state: 'committed-object-binding-observed',
                            });
                            expect(await docs.model.count()).toBe(2);
                          } finally {
                            await other.db.close();
                          }
                        });

                        it('keeps missing object evidence and prepared SQL outcomes unknown', async () => {
                          const { entry, evidence } = await execution();
                          await entry.executeNativeRemoval(evidence);
                          const prepared = (await intents.model.findOne()).getDataValue('id');
                          const other = await observer(objects);
                          try {
                            expect(await other.inspector.inspectLocalObject(prepared)).toEqual({ state: 'unknown' });
                            expect(
                              await other.inspector.inspectLocalObject('00000000-0000-4000-8000-000000000000'),
                            ).toEqual({ state: 'unknown' });
                          } finally {
                            await other.db.close();
                          }
                        });

                        it('keeps a valid SQL completion without the optional object evidence unknown to the object reader', async () => {
                          const { entry } = await execution();
                          const result = await files.executeRecordedAttachmentRemoval(entry, journal, native);
                          const other = await observer(objects);
                          try {
                            expect(await other.inspector.inspectLocalObject(result.operationId)).toEqual({
                              state: 'unknown',
                            });
                            expect(await other.inspector.inspect(result.operationId)).toMatchObject({
                              state: 'committed-sql-observed',
                            });
                          } finally {
                            await other.db.close();
                          }
                        });

                        it('requires an explicitly configured object mapping rather than using an upload journal', async () => {
                          const result = await runBound();
                          const other = await observer();
                          try {
                            await expect(other.inspector.inspectLocalObject(result.operationId)).rejects.toThrow(
                              'Object inspection requires an explicit independent object mapping',
                            );
                          } finally {
                            await other.db.close();
                          }
                        });

                        it.each([
                          'source',
                          'transaction',
                          'owner',
                          'intent id',
                          'intent journal',
                          'object journal',
                          'extra field',
                          'inode',
                          'inode newline',
                          'mtime newline',
                          'directory identity newline',
                          'birthtime',
                          'size',
                          'directory',
                          'collection',
                          'root',
                        ])('rejects persisted object binding drift: %s', async (change) => {
                          const result = await runBound();
                          const row = await objects.model.findByPk(result.operationId);
                          const payload = structuredClone(row.getDataValue('payload'));
                          if (change === 'source') payload.intent.payload.source.oid = '1';
                          if (change === 'transaction') payload.intent.payload.transactionId = '1';
                          if (change === 'owner') payload.intent.payload.record.tenantId = 'H';
                          if (change === 'intent id') payload.intent.id = '00000000-0000-4000-8000-000000000000';
                          if (change === 'intent journal') payload.intent.journal.oid = '1';
                          if (change === 'object journal') payload.journal.oid = '1';
                          if (change === 'extra field') payload.extra = true;
                          if (change === 'inode') payload.object.object.ino = '01';
                          if (change === 'inode newline') payload.object.object.ino += '\n';
                          if (change === 'mtime newline') payload.object.object.mtimeNs += '\n';
                          if (change === 'directory identity newline') payload.object.directories[0].dev += '\n';
                          if (change === 'birthtime') payload.object.object.birthtimeNs = '0';
                          if (change === 'size') payload.object.object.size = '999999';
                          if (change === 'directory') payload.object.directories[1].path = '../elsewhere';
                          if (change === 'collection') payload.object.collectionName = 'other_documents';
                          if (change === 'root') payload.object.configuredRoot = path.join(root, 'other');
                          await row.update({ payload });
                          const other = await observer(objects);
                          try {
                            await expect(other.inspector.inspectLocalObject(result.operationId)).rejects.toThrow(
                              'Removal object binding is invalid or inconsistent',
                            );
                          } finally {
                            await other.db.close();
                          }
                          expect(await fs.readFile(location())).toEqual(bytes);
                        });

                        it('rejects a same-name object table recreated with copied exact evidence', async () => {
                          const result = await runBound();
                          await db.sequelize
                            .query(`CREATE TABLE replacement_objects (LIKE attachment_removal_objects INCLUDING ALL);
                            INSERT INTO replacement_objects SELECT * FROM attachment_removal_objects;
                            DROP TABLE attachment_removal_objects;
                            ALTER TABLE replacement_objects RENAME TO attachment_removal_objects;`);
                          const other = await observer(objects);
                          try {
                            await expect(other.inspector.inspectLocalObject(result.operationId)).rejects.toThrow(
                              'Removal object binding is invalid or inconsistent',
                            );
                          } finally {
                            await other.db.close();
                          }
                        });

                        it('rejects object RLS even when the table owner can still read every row', async () => {
                          const result = await runBound();
                          await db.sequelize.query('ALTER TABLE attachment_removal_objects ENABLE ROW LEVEL SECURITY');
                          const other = await observer(objects);
                          try {
                            await expect(other.inspector.inspectLocalObject(result.operationId)).rejects.toThrow(
                              'Completion journal has unsupported database behavior',
                            );
                          } finally {
                            await other.db.close();
                          }
                        });
                      });

                      it('commits one object binding, full OLD and v3 completion with the same original UUID and transaction', async () => {
                        const object = await fs.lstat(location(), { bigint: true });
                        const result = await runBound();
                        const bound = (await objects.model.findByPk(result.operationId)).getDataValue('payload');
                        const completion = (await intents.model.findByPk(result.operationId)).getDataValue('payload');
                        const event = (await events.model.findByPk(result.operationId)).getDataValue('payload');
                        expect(bound).toMatchObject({
                          kind: 'attachment-removal-bound-local-object',
                          intent: {
                            id: result.operationId,
                            payload: { schemaVersion: 2, state: 'prepared', transactionId: completion.transactionId },
                          },
                          object: { object: { ino: String(object.ino), birthtimeNs: String(object.birthtimeNs) } },
                        });
                        expect(completion.schemaVersion).toBe(3);
                        expect(event.transactionId).toBe(completion.transactionId);
                        expect(event.source.oid).toBe(bound.intent.payload.source.oid);
                        expect(event.record.tenantId).toBe(bound.intent.payload.record.tenantId);
                        expect(await docs.model.findByPk(1)).toBeNull();
                        // Existing records still reference these bytes; SQL completion grants no cleanup.
                        expect(await docs.model.count()).toBe(2);
                        expect(await fs.readFile(location())).toEqual(bytes);
                      });

                      it('leaves object persistence off in the default recorded execution', async () => {
                        const { entry } = await execution();
                        await files.executeRecordedAttachmentRemoval(entry, journal, native);
                        expect(await objects.model.count()).toBe(0);
                        expect(await fs.readFile(location())).toEqual(bytes);
                      });

                      it('rolls the object binding back with a real Repository hook failure and preserves its unknown UUID', async () => {
                        docs.model.addHook('afterDestroy', async (_row, { transaction }) => {
                          expect(await objects.model.count({ transaction })).toBe(1);
                          throw new Error('bound Repository refusal');
                        });
                        const failure = await runBound().catch((error: unknown) => error);
                        expect(failure).toBeInstanceOf(files.AttachmentRemovalOutcomeError);
                        expect(failure).toMatchObject({
                          outcome: 'unknown',
                          operationId: expect.any(String),
                          errors: [expect.objectContaining({ message: 'bound Repository refusal' })],
                        });
                        expect(await objects.model.count()).toBe(0);
                        await assertRollback();
                      });

                      it.each(['changed', 'missing'])(
                        'forces rollback when a later Repository hook leaves %s object evidence',
                        async (kind) => {
                          docs.model.addHook('afterDestroy', async (_row, { transaction }) => {
                            if (kind === 'missing') await objects.model.destroy({ where: {}, transaction });
                            else
                              await objects.model.update(
                                { payload: { kind: 'replacement' } },
                                { where: {}, transaction },
                              );
                          });
                          const failure = await runBound().catch((error: unknown) => error);
                          expect(failure).toBeInstanceOf(files.AttachmentRemovalOutcomeError);
                          expect(failure).toMatchObject({
                            errors: [
                              expect.objectContaining({
                                message: 'Removal object evidence no longer matches its original binding',
                              }),
                            ],
                          });
                          expect(await objects.model.count()).toBe(0);
                          await assertRollback();
                        },
                      );

                      it('rechecks the object binding after a real completion CHECK function changes it', async () => {
                        await db.sequelize.query(`
                          CREATE FUNCTION tamper_bound_completion(value jsonb) RETURNS boolean LANGUAGE plpgsql AS $$
                          BEGIN IF value->>'schemaVersion'='3' THEN
                            UPDATE attachment_removal_objects SET payload='{"kind":"replacement"}'::jsonb;
                          END IF; RETURN true; END $$;
                          ALTER TABLE attachment_removal_intents ADD CONSTRAINT bound_completion_check CHECK(tamper_bound_completion(payload));
                        `);
                        const failure = await runBound().catch((error: unknown) => error);
                        expect(failure).toBeInstanceOf(files.AttachmentRemovalOutcomeError);
                        expect(failure).toMatchObject({
                          errors: [
                            expect.objectContaining({
                              message: 'Removal object evidence no longer matches its original binding',
                            }),
                          ],
                        });
                        expect(await objects.model.count()).toBe(0);
                        await assertRollback();
                      });

                      it('preserves committed object evidence after afterCommit rejects without treating it as a cleanup receipt', async () => {
                        sourceAfterCommitFailure();
                        const failure = await runBound().catch((error: unknown) => error);
                        expect(failure).toBeInstanceOf(files.AttachmentRemovalOutcomeError);
                        const result = failure as InstanceType<typeof files.AttachmentRemovalOutcomeError>;
                        expect(result.outcome).toBe('unknown');
                        expect(await objects.model.findByPk(result.operationId)).not.toBeNull();
                        expect(await docs.model.findByPk(1)).toBeNull();
                        const other = await observer();
                        try {
                          expect(await other.inspector.inspect(result.operationId)).toMatchObject({
                            state: 'committed-sql-observed',
                          });
                        } finally {
                          await other.db.close();
                        }
                        expect(await fs.readFile(location())).toEqual(bytes);
                      });

                      it('fails missing-file preparation without deleting SQL rows or reusing a previous operation id', async () => {
                        await fs.unlink(location());
                        const failure = await runBound().catch((error: unknown) => error);
                        expect(failure).toMatchObject({ code: 'ENOENT' });
                        expect(failure).not.toHaveProperty('operationId');
                        expect(await objects.model.count()).toBe(0);
                        expect(await intents.model.count()).toBe(0);
                        expect(await events.model.count()).toBe(0);
                        expect(await docs.model.count()).toBe(3);
                      });
                    });

                    it('returns the committed operation id for subsequent independent inspection', async () => {
                      const { entry } = await execution();
                      const result = await files.executeRecordedAttachmentRemoval(entry, journal, native);
                      const id = (await intents.model.findOne()).getDataValue('id');
                      expect(result).toEqual({ affected: 1, operationId: id });
                      const other = await observer();
                      try {
                        expect(await other.inspector.inspect(result.operationId)).toMatchObject({
                          state: 'committed-sql-observed',
                          operationId: id,
                        });
                        expect(await fs.readFile(location())).toEqual(bytes);
                      } finally {
                        await other.db.close();
                      }
                    });

                    it('preserves correlation after a real afterCommit failure without inferring rollback or deleting bytes', async () => {
                      sourceAfterCommitFailure();
                      const { entry } = await execution();
                      let failure: InstanceType<typeof files.AttachmentRemovalOutcomeError>;
                      try {
                        await files.executeRecordedAttachmentRemoval(entry, journal, native);
                        throw new Error('expected post-commit failure');
                      } catch (error) {
                        expect(error).toBeInstanceOf(files.AttachmentRemovalOutcomeError);
                        failure = error as typeof failure;
                      }
                      expect(failure!.outcome).toBe('unknown');
                      expect(failure!.errors[0]).toMatchObject({ message: 'real afterCommit failure' });
                      expect(await docs.model.findByPk(1)).toBeNull();
                      const other = await observer();
                      try {
                        expect(await other.inspector.inspect(failure!.operationId)).toMatchObject({
                          state: 'committed-sql-observed',
                          operationId: failure!.operationId,
                        });
                        expect(await fs.readFile(location())).toEqual(bytes);
                      } finally {
                        await other.db.close();
                      }
                    });

                    function sourceAfterCommitFailure() {
                      docs.model.addHook('afterDestroy', (_row, { transaction }) => {
                        transaction.afterCommit(() => {
                          throw new Error('real afterCommit failure');
                        });
                      });
                    }

                    it('retains a fresh operation id after Repository rollback and leaves unknown evidence alone', async () => {
                      docs.model.addHook('afterDestroy', () => {
                        throw new Error('real Repository refusal');
                      });
                      const { entry } = await execution();
                      let failure: InstanceType<typeof files.AttachmentRemovalOutcomeError>;
                      try {
                        await files.executeRecordedAttachmentRemoval(entry, journal, native);
                        throw new Error('expected rollback');
                      } catch (error) {
                        expect(error).toBeInstanceOf(files.AttachmentRemovalOutcomeError);
                        failure = error as typeof failure;
                      }
                      expect(failure!.outcome).toBe('unknown');
                      expect(failure!.errors[0]).toMatchObject({ message: 'real Repository refusal' });
                      const other = await observer();
                      try {
                        expect(await other.inspector.inspect(failure!.operationId)).toEqual({ state: 'unknown' });
                        await assertRollback();
                      } finally {
                        await other.db.close();
                      }
                    });

                    it('does not reuse an earlier operation id when an entry has already been consumed', async () => {
                      const { entry } = await execution();
                      await files.executeRecordedAttachmentRemoval(entry, journal, native);
                      let failure: unknown;
                      try {
                        await files.executeRecordedAttachmentRemoval(entry, journal, native);
                      } catch (error) {
                        failure = error;
                      }
                      expect(failure).not.toBeInstanceOf(files.AttachmentRemovalOutcomeError);
                      expect(failure).not.toHaveProperty('operationId');
                      expect(failure).toMatchObject({ message: expect.stringContaining('already been used') });
                      expect(await intents.model.count()).toBe(1);
                      expect(await fs.readFile(location())).toEqual(bytes);
                    });

                    it('does not issue a correlation id when final destroy authorization rejects before preparation', async () => {
                      const { entry } = await execution(2);
                      let failure: unknown;
                      try {
                        await files.executeRecordedAttachmentRemoval(entry, journal, native);
                      } catch (error) {
                        failure = error;
                      }
                      expect(failure).toBeTruthy();
                      expect(failure).toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
                      expect(failure).not.toHaveProperty('operationId');
                      expect(await intents.model.count()).toBe(0);
                      expect(await docs.model.count()).toBe(3);
                      expect(await fs.readFile(location())).toEqual(bytes);
                    });
                  });

                  async function observer(
                    objects?: Collection,
                    references?: readonly Collection[],
                    fence?: Collection,
                  ) {
                    const other = isolatedPostgresDatabase(testPostgresUrl!);
                    try {
                      other.collection(storageDefinition);
                      const source = other.collection({ ...docs.options });
                      const intent = other.collection({ ...intents.options });
                      const event = other.collection({ ...events.options });
                      const object = objects ? other.collection({ ...objects.options }) : undefined;
                      const referenceMappings = references
                        ? {
                            sources: references.map((value) =>
                              value === docs ? source : other.collection({ ...value.options }),
                            ),
                            storages: other.getCollection('storages'),
                          }
                        : undefined;
                      return {
                        db: other,
                        inspector: new files.AttachmentRemovalCompletionInspector(
                          db,
                          source,
                          intent,
                          event,
                          object,
                          referenceMappings,
                          fence ? { fence: other.collection({ ...fence.options }) } : undefined,
                        ),
                      };
                    } catch (error) {
                      await other.close();
                      throw error;
                    }
                  }

                  async function completed() {
                    const { entry, evidence } = await execution(1, true);
                    expect(await entry.executeNativeRemoval(evidence)).toBe(1);
                    return (await intents.model.findOne()).getDataValue('id') as string;
                  }

                  it('observes an actual committed completion from fresh mappings without the original handle', async () => {
                    const id = await completed();
                    const other = await observer();
                    try {
                      const payload = (await intents.model.findByPk(id)).getDataValue('payload');
                      expect(await other.inspector.inspect(id)).toEqual({
                        state: 'committed-sql-observed',
                        operationId: id,
                        transactionId: payload.transactionId,
                      });
                      expect(await fs.readFile(location())).toEqual(bytes);
                      expect(await intents.model.count()).toBe(1);
                      expect(await events.model.count()).toBe(1);
                    } finally {
                      await other.db.close();
                    }
                  });

                  it('keeps missing and prepared-only outcomes unknown without granting cleanup', async () => {
                    const { entry, evidence } = await execution();
                    await entry.executeNativeRemoval(evidence);
                    const id = (await intents.model.findOne()).getDataValue('id');
                    const other = await observer();
                    try {
                      expect(await other.inspector.inspect(id)).toEqual({ state: 'unknown' });
                      expect(await other.inspector.inspect('11111111-1111-1111-1111-111111111111')).toEqual({
                        state: 'unknown',
                      });
                      expect(await fs.readFile(location())).toEqual(bytes);
                    } finally {
                      await other.db.close();
                    }
                  });

                  it.each([false, true])(
                    'keeps an in-flight completion unknown, then observes rollback=%s honestly',
                    async (rollback) => {
                      const { entry, evidence } = await execution(1, true);
                      const other = await observer();
                      let id: string;
                      try {
                        const run = entry.executeNativeRemoval({
                          async prepare(proof) {
                            const session = await evidence.prepare(proof);
                            return {
                              ...session,
                              async complete() {
                                await session.complete();
                                id = (await intents.model.findOne({ transaction: proof.transaction })).getDataValue(
                                  'id',
                                );
                                expect(await other.inspector.inspect(id)).toEqual({ state: 'unknown' });
                                if (rollback) throw new Error('rollback after completion');
                              },
                            };
                          },
                        });
                        if (rollback) await expect(run).rejects.toThrow('rollback after completion');
                        else await expect(run).resolves.toBe(1);
                        expect((await other.inspector.inspect(id!)).state).toBe(
                          rollback ? 'unknown' : 'committed-sql-observed',
                        );
                        expect(await fs.readFile(location())).toEqual(bytes);
                      } finally {
                        await other.db.close();
                      }
                    },
                  );

                  it('rejects reusing the business pool for outcome inspection', () => {
                    expect(() => new files.AttachmentRemovalCompletionInspector(db, docs, intents, events)).toThrow(
                      'independent pool for the same database',
                    );
                  });

                  it('rejects endpoint drift after constructing an independent inspector', async () => {
                    const other = await observer();
                    const port = other.db.options.port;
                    try {
                      other.db.options.port = Number(port) + 1;
                      await expect(other.inspector.inspect('11111111-1111-1111-1111-111111111111')).rejects.toThrow(
                        'independent pool for the same database',
                      );
                    } finally {
                      other.db.options.port = port;
                      await other.db.close();
                    }
                  });

                  it.each(['intent RLS', 'event RLS', 'disabled capture'])(
                    'rejects persisted evidence after actual catalog drift: %s',
                    async (change) => {
                      const id = await completed();
                      const statements = {
                        'intent RLS': 'ALTER TABLE attachment_removal_intents ENABLE ROW LEVEL SECURITY',
                        'event RLS': 'ALTER TABLE attachment_removal_events ENABLE ROW LEVEL SECURITY',
                        'disabled capture': 'ALTER TABLE documents DISABLE TRIGGER tac_remove_capture',
                      };
                      await db.sequelize.query(statements[change]);
                      const other = await observer();
                      try {
                        await expect(other.inspector.inspect(id)).rejects.toThrow(
                          /unsupported database behavior|installation is unavailable or changed/,
                        );
                      } finally {
                        await other.db.close();
                      }
                    },
                  );

                  it.each(['transaction', 'source', 'owner', 'storage', 'capture', 'extra'])(
                    'rejects a persisted completion with inconsistent %s metadata',
                    async (change) => {
                      const id = await completed();
                      const mutations = {
                        transaction: `jsonb_set(payload::jsonb, '{transactionId}', '"3"')`,
                        source: `jsonb_set(payload::jsonb, '{source,oid}', '"1"')`,
                        owner: `jsonb_set(payload::jsonb, '{record,tenantId}', '"H"')`,
                        storage: `jsonb_set(payload::jsonb, '{storage,retainContent}', '"false"')`,
                        capture: `jsonb_set(payload::jsonb, '{completion,nativeCapture}', '"untrusted_capture"')`,
                        extra: `payload::jsonb || '{"unverified":true}'::jsonb`,
                      };
                      await db.sequelize.query(`UPDATE attachment_removal_intents SET payload=${mutations[change]}`);
                      const other = await observer();
                      try {
                        await expect(other.inspector.inspect(id)).rejects.toThrow();
                        expect(await fs.readFile(location())).toEqual(bytes);
                      } finally {
                        await other.db.close();
                      }
                    },
                  );

                  it('rejects a completed marker whose native event is missing', async () => {
                    const id = await completed();
                    await events.model.destroy({ where: { id }, hooks: false });
                    const other = await observer();
                    try {
                      await expect(other.inspector.inspect(id)).rejects.toThrow(
                        'Native full-row event does not match its prepared intent',
                      );
                    } finally {
                      await other.db.close();
                    }
                  });

                  it('does not mistake a committed observation for present absence or exclusive file ownership', async () => {
                    const id = await completed();
                    await docs.model.create({
                      id: 1,
                      tenantId: 'B',
                      path: 'old/tenants/H',
                      filename: 'receipt.txt',
                      storageId: 18,
                      size: bytes.length,
                    });
                    const other = await observer();
                    try {
                      expect((await other.inspector.inspect(id)).state).toBe('committed-sql-observed');
                      expect(await docs.model.count()).toBe(3);
                      expect(await fs.readFile(location())).toEqual(bytes);
                    } finally {
                      await other.db.close();
                    }
                  });
                });

                it('commits a distinct completed format visible from an independent pool while retaining bytes', async () => {
                  const { entry, evidence } = await execution(1, true);
                  const other = isolatedPostgresDatabase(postgresUrl!);
                  try {
                    const observed = {
                      async prepare(proof) {
                        const session = await evidence.prepare(proof);
                        return {
                          ...session,
                          async complete() {
                            await session.complete();
                            const [pending] = await other.sequelize.query('SELECT id FROM attachment_removal_intents');
                            expect(pending).toEqual([]);
                            const [source] = await other.sequelize.query('SELECT id FROM documents WHERE id=1');
                            expect(source).toEqual([{ id: 1 }]);
                          },
                        };
                      },
                    };
                    expect(await entry.executeNativeRemoval(observed)).toBe(1);
                    const [rows] = await other.sequelize.query('SELECT id, payload FROM attachment_removal_intents');
                    expect(rows).toHaveLength(1);
                    expect(rows[0]).toMatchObject({
                      payload: {
                        schemaVersion: 3,
                        kind: 'attachment-removal-intent',
                        state: 'verified-deleted-in-transaction',
                        source: { collectionName: 'documents' },
                        record: { key: 1, tenantId: 'B', storageId: 18 },
                        storage: { root, retainContent: false },
                        completion: {
                          schemaVersion: 1,
                          kind: 'attachment-removal-sql-completion',
                          nativeCapture: native.functionName,
                        },
                      },
                    });
                    const [matched] = await other.sequelize.query(`SELECT
                      i.payload->>'transactionId' = e.payload->>'transactionId' AS same_transaction
                      FROM attachment_removal_intents i JOIN attachment_removal_events e ON i.id=e.id`);
                    expect(matched).toEqual([{ same_transaction: true }]);
                    const [source] = await other.sequelize.query('SELECT id FROM documents WHERE id=1');
                    expect(source).toEqual([]);
                  } finally {
                    await other.close();
                  }
                  expect(await fs.readFile(location())).toEqual(bytes);
                });

                it('keeps completed observations on the original handle and rejects prepared-format reuse', async () => {
                  let recorded: Readonly<{ id: string }>;
                  await exerciseRow(async (handle, transaction, predicate) => {
                    recorded = handle;
                    await journal.completeNativeRemoval(handle, native, transaction, predicate);
                    expect(await journal.testCompletedNativeRowPredicate(handle, native, transaction, predicate)).toBe(
                      true,
                    );
                    await expect(
                      journal.testNativeRowPredicate(handle, native, transaction, predicate),
                    ).rejects.toThrow('Removal intent no longer matches its original preparation');
                    await expect(
                      journal.testCompletedNativeRowPredicate({ id: handle.id }, native, transaction, predicate),
                    ).rejects.toThrow('Original removal intent handle is unavailable');
                    await db.sequelize.transaction(async (other) => {
                      await expect(
                        journal.testCompletedNativeRowPredicate(handle, native, other, predicate),
                      ).rejects.toThrow('Original removal intent transaction is unavailable');
                    });
                  });
                  await expect(
                    journal.testCompletedNativeRowPredicate(recorded, native, undefined!, {
                      sql: 'TRUE',
                      rootAlias: 'documents',
                    }),
                  ).rejects.toThrow('Original removal intent transaction is unavailable');
                  expect(await fs.readFile(location())).toEqual(bytes);
                });

                it('leaves the existing prepared format unchanged when completion is not enabled', async () => {
                  const { entry, evidence } = await execution();
                  expect(await entry.executeNativeRemoval(evidence)).toBe(1);
                  expect((await intents.model.findOne()).getDataValue('payload')).toMatchObject({
                    schemaVersion: 2,
                    state: 'prepared',
                  });
                  expect((await intents.model.findOne()).getDataValue('payload')).not.toHaveProperty('completion');
                });

                it.each(['revocation', 'hook error'])(
                  'rolls back without recording completion after %s',
                  async (failure) => {
                    docs.model.addHook('afterDestroy', async (_row, { transaction }) => {
                      if (failure === 'hook error') throw new Error('completion hook refused');
                      await facts.model.update({ allowed: false }, { where: { documentId: 1 }, transaction });
                    });
                    const { entry, evidence } = await execution(1, true);
                    await expect(entry.executeNativeRemoval(evidence)).rejects.toThrow(
                      failure === 'hook error' ? 'completion hook refused' : 'final native authorization failed',
                    );
                    await assertRollback();
                  },
                );

                it.each(['RLS', 'rule', 'trigger'])(
                  'rejects completion journal %s before deleting the original',
                  async (behavior) => {
                    if (behavior === 'RLS')
                      await db.sequelize.query('ALTER TABLE attachment_removal_intents ENABLE ROW LEVEL SECURITY');
                    else if (behavior === 'rule')
                      await db.sequelize.query(
                        `CREATE RULE completion_journal_rule AS ON UPDATE TO attachment_removal_intents DO INSTEAD NOTHING`,
                      );
                    else
                      await db.sequelize.query(`
                      CREATE FUNCTION tamper_removal_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
                      CREATE TRIGGER completion_journal_trigger BEFORE UPDATE ON attachment_removal_intents
                      FOR EACH ROW EXECUTE FUNCTION tamper_removal_intent()`);
                    let deletes = 0;
                    docs.model.addHook('beforeDestroy', () => {
                      deletes++;
                    });
                    const { entry, evidence } = await execution(1, true);
                    await expect(entry.executeNativeRemoval(evidence)).rejects.toThrow(
                      'Completion journal has unsupported database behavior',
                    );
                    expect(deletes).toBe(0);
                    await assertRollback();
                  },
                );

                it('rolls back the original deletion when writing completion fails', async () => {
                  await db.sequelize.query(`ALTER TABLE attachment_removal_intents ADD CONSTRAINT completion_refused
                    CHECK ((payload->>'schemaVersion')::integer <> 3)`);
                  const { entry, evidence } = await execution(1, true);
                  await expect(entry.executeNativeRemoval(evidence)).rejects.toThrow('completion_refused');
                  await assertRollback();
                });

                it.each(['G', 'role'])('rolls back %s revoked by a completion CHECK function', async (policy) => {
                  const field = policy === 'G' ? 'allowed' : 'authorized';
                  await db.sequelize.query(`
                    CREATE FUNCTION completion_authority_check(input jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
                    BEGIN
                      IF input->>'schemaVersion'='3' THEN
                        UPDATE "removalPolicyFacts" SET ${field}=FALSE WHERE "documentId"=1;
                      END IF;
                      RETURN TRUE;
                    END $$;
                    ALTER TABLE attachment_removal_intents ADD CONSTRAINT completion_authority
                    CHECK (completion_authority_check(payload::jsonb))`);
                  try {
                    const { entry, evidence } = await execution(1, true);
                    await expect(entry.executeNativeRemoval(evidence)).rejects.toThrow(
                      'final native authorization failed',
                    );
                    await assertRollback();
                  } finally {
                    await db.sequelize.query('DROP FUNCTION completion_authority_check(jsonb) CASCADE');
                  }
                });

                it.each(['decision drift', 'error'])(
                  'rolls back an already written completion after a final %s',
                  async (failure) => {
                    const { ctx, entry, evidence } = await execution(1, true);
                    const decorated = {
                      async prepare(proof) {
                        const session = await evidence.prepare(proof);
                        return {
                          ...session,
                          async complete() {
                            await session.complete();
                            expect(
                              (await intents.model.findOne({ transaction: proof.transaction })).getDataValue('payload'),
                            ).toMatchObject({
                              schemaVersion: 3,
                              state: 'verified-deleted-in-transaction',
                            });
                            if (failure === 'error') throw new Error('post completion refused');
                            Object.assign(ctx.permission as object, { can: false, skip: false });
                          },
                        };
                      },
                    };
                    await expect(entry.executeNativeRemoval(decorated)).rejects.toThrow(
                      failure === 'error' ? 'post completion refused' : 'final decision or preparation phase changed',
                    );
                    await assertRollback();
                  },
                );
              });

              it.each([true, false])(
                'owns the SQL transaction and keeps bytes with storage retention %s',
                async (retain) => {
                  await db.getCollection('storages').model.update({ paranoid: retain }, { where: { id: 18 } });
                  const { entry, evidence } = await execution();
                  let before = 0;
                  let after = 0;
                  docs.model.addHook('beforeDestroy', (row) => {
                    before++;
                    row.setDataValue('filename', 'memory-only.txt');
                  });
                  docs.model.addHook('afterDestroy', () => {
                    after++;
                  });
                  expect(await entry.executeNativeRemoval(evidence)).toBe(1);
                  expect(before).toBe(1);
                  expect(after).toBe(1);
                  expect(await docs.model.findByPk(1)).toBeNull();
                  expect(await docs.model.count()).toBe(2);
                  expect(await intents.model.count()).toBe(1);
                  expect(await events.model.count()).toBe(1);
                  expect(await fs.readFile(location())).toEqual(bytes);
                  await expect(entry.executeNativeRemoval(evidence)).rejects.toThrow('already been used');
                },
              );

              it('rejects an initially unauthorized actual record without creating an intent', async () => {
                const { entry, evidence } = await execution(2);
                await expect(entry.executeNativeRemoval(evidence)).rejects.toMatchObject({
                  code: 'ACCESS_RECORD_UNAVAILABLE',
                });
                await assertRollback();
              });

              it('rejects a location-only installation before Repository deletion', async () => {
                await db.sequelize.query(`DROP FUNCTION ${native.functionName}() CASCADE`);
                native = new files.AttachmentRemovalNativeCapture(docs, events);
                await db.sequelize.transaction((transaction) => native.install(transaction));
                const { entry, evidence } = await execution();
                await expect(entry.executeNativeRemoval(evidence)).rejects.toThrow(
                  'requires the full-row installation',
                );
                await assertRollback();
              });

              it.each(['cascade', 'rule', 'RLS'])(
                'rejects unmodeled source %s behavior before deletion',
                async (behavior) => {
                  if (behavior === 'cascade')
                    await db.sequelize.query(`
                  CREATE TABLE unmodeled_removal_dependent(id integer PRIMARY KEY, file_id integer REFERENCES documents(id) ON DELETE CASCADE);
                  INSERT INTO unmodeled_removal_dependent VALUES (1, 1)`);
                  else if (behavior === 'rule')
                    await db.sequelize.query(`CREATE RULE unmodeled_removal_rule AS ON DELETE TO documents
                  DO ALSO UPDATE "removalPolicyFacts" SET allowed=TRUE WHERE "documentId"=OLD.id`);
                  else await db.sequelize.query('ALTER TABLE documents ENABLE ROW LEVEL SECURITY');
                  try {
                    const { entry, evidence } = await execution();
                    await expect(entry.executeNativeRemoval(evidence)).rejects.toThrow(
                      'unsupported source database behavior',
                    );
                    await assertRollback();
                    if (behavior === 'cascade') {
                      const [rows] = await db.sequelize.query(
                        'SELECT count(*)::text AS count FROM unmodeled_removal_dependent',
                      );
                      expect(rows).toEqual([{ count: '1' }]);
                    }
                  } finally {
                    if (behavior === 'cascade') await db.sequelize.query('DROP TABLE unmodeled_removal_dependent');
                  }
                },
              );

              it('rolls back a SQL-cancelled DELETE rather than accepting an afterDestroy notification', async () => {
                await db.sequelize
                  .query(`CREATE FUNCTION tamper_native_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
                  BEGIN RETURN NULL; END $$;
                  CREATE TRIGGER cancel_execution BEFORE DELETE ON documents FOR EACH ROW EXECUTE FUNCTION tamper_native_evidence()`);
                const { entry, evidence } = await execution();
                await expect(entry.executeNativeRemoval(evidence)).rejects.toThrow(
                  'did not delete exactly one original row',
                );
                await assertRollback();
              });

              it('rolls back a later Repository hook error inside its owned transaction', async () => {
                docs.model.addHook('afterBulkDestroy', () => {
                  throw new Error('execution hook refused');
                });
                const { entry, evidence } = await execution();
                await expect(entry.executeNativeRemoval(evidence)).rejects.toThrow('execution hook refused');
                await assertRollback();
              });

              it.each([
                'G scalar',
                'G beforeDestroy',
                'role beforeDestroy',
                'G BEFORE',
                'role BEFORE',
                'G AFTER',
                'role AFTER',
                'G afterDestroy',
                'role afterDestroy',
                'G afterBulkDestroy',
                'role afterBulkDestroy',
              ])('forces rollback after final %s revocation', async (change) => {
                const field = change.startsWith('G') ? 'allowed' : 'authorized';
                if (change.endsWith('AFTER') || change.endsWith('BEFORE'))
                  await db.sequelize.query(`
                    CREATE FUNCTION tamper_native_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
                    BEGIN UPDATE "removalPolicyFacts" SET ${field}=FALSE WHERE "documentId"=OLD.id; RETURN OLD; END $$;
                    CREATE TRIGGER zz_revoke_execution ${change.endsWith('AFTER') ? 'AFTER' : 'BEFORE'} DELETE ON documents FOR EACH ROW EXECUTE FUNCTION tamper_native_evidence()`);
                else if (change.endsWith('afterBulkDestroy'))
                  docs.model.addHook('afterBulkDestroy', async ({ transaction }) => {
                    await facts.model.update({ [field]: false }, { where: { documentId: 1 }, transaction });
                  });
                else
                  docs.model.addHook(
                    change.endsWith('afterDestroy') ? 'afterDestroy' : 'beforeDestroy',
                    async (_row, { transaction }) => {
                      if (change === 'G scalar')
                        await docs.model.update({ viewable: true }, { where: { id: 1 }, hooks: false, transaction });
                      else await facts.model.update({ [field]: false }, { where: { documentId: 1 }, transaction });
                    },
                  );
                const { entry, evidence } = await execution();
                await expect(entry.executeNativeRemoval(evidence)).rejects.toThrow('final native authorization failed');
                await assertRollback();
              });

              it.each(['location', 'owner'])('rolls back actual beforeDestroy %s drift', async (change) => {
                docs.model.addHook('beforeDestroy', async (_row, { transaction }) => {
                  await docs.model.update(change === 'location' ? { path: 'changed' } : { tenantId: 'H' }, {
                    where: { id: 1 },
                    hooks: false,
                    transaction,
                  });
                });
                const { entry, evidence } = await execution();
                await expect(entry.executeNativeRemoval(evidence)).rejects.toThrow(
                  'Native full-row event does not match its prepared intent',
                );
                await assertRollback();
              });

              it('rejects a same-key row recreated by afterDestroy despite an actual deletion event', async () => {
                docs.model.addHook('afterDestroy', async (_row, { transaction }) => {
                  await docs.model.create(
                    {
                      id: 1,
                      tenantId: 'B',
                      viewable: false,
                      path: 'old/tenants/H',
                      filename: 'receipt.txt',
                      size: bytes.length,
                      storageId: 18,
                    },
                    { transaction },
                  );
                });
                const { entry, evidence } = await execution();
                await expect(entry.executeNativeRemoval(evidence)).rejects.toThrow(
                  'source row still exists after deletion',
                );
                await assertRollback();
              });

              it.each(['decision', 'phase', 'storage'])(
                'rejects final %s drift after Repository hooks',
                async (change) => {
                  const { ctx, entry, evidence } = await execution();
                  docs.model.addHook('afterDestroy', async (_row, { transaction }) => {
                    if (change === 'decision') Object.assign(ctx.permission as object, { can: false, skip: false });
                    else if (change === 'phase') {
                      adapter.release(ctx);
                      await adapter.prepare(ctx, [mainIdentity]);
                    } else
                      await db
                        .getCollection('storages')
                        .model.update({ paranoid: true }, { where: { id: 18 }, transaction });
                  });
                  await expect(entry.executeNativeRemoval(evidence)).rejects.toThrow(/changed|phase/);
                  await assertRollback();
                },
              );

              it.each(['G', 'role'])('rolls back %s revoked by a deferred constraint trigger', async (policy) => {
                const field = policy === 'G' ? 'allowed' : 'authorized';
                await db.sequelize.query(`
                  CREATE FUNCTION tamper_native_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
                  BEGIN UPDATE "removalPolicyFacts" SET ${field}=FALSE WHERE "documentId"=OLD.id; RETURN OLD; END $$;
                  CREATE CONSTRAINT TRIGGER deferred_execution_revoke AFTER DELETE ON documents
                  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tamper_native_evidence()`);
                const { entry, evidence } = await execution();
                await expect(entry.executeNativeRemoval(evidence)).rejects.toThrow('final native authorization failed');
                await assertRollback();
              });

              it('recomputes tenant hierarchy changed by afterDestroy instead of using the preparation SQL', async () => {
                db.getCollection('tenants').setField('parentId', { type: 'string' });
                await db.sequelize.query('ALTER TABLE tenants ADD COLUMN "parentId" varchar(255)');
                await db.getCollection('tenants').model.update({ parentId: 'H' }, { where: { id: 'B' } });
                await docs.model.update({ tenantId: 'H' }, { where: { id: 1 } });
                const store = new AccessConfigStore(db, (value) =>
                  resolveModelMetadata(db.getCollection(value.collectionName), {
                    resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
                  }),
                );
                const saved = await store.read(mainIdentity);
                await store.save(
                  mainIdentity,
                  {
                    ...configFor({
                      type: 'tenantRelation',
                      tenant: { type: 'field', path: 'tenantId' },
                      relation: 'descendant',
                      includeSelf: false,
                    }),
                    revision: saved!.revision,
                  },
                  { userId: 28 },
                );
                docs.model.addHook('afterDestroy', async (_row, { transaction }) => {
                  await db
                    .getCollection('tenants')
                    .model.update({ parentId: null }, { where: { id: 'B' }, transaction });
                });
                const { entry, evidence } = await execution();
                await expect(entry.executeNativeRemoval(evidence)).rejects.toThrow('final native authorization failed');
                expect((await db.getCollection('tenants').model.findByPk('B')).getDataValue('parentId')).toBe('H');
                await assertRollback();
              });
            });
          });

          it('rejects a real beforeDestroy location change rather than trusting the old model instance', async () => {
            docs.model.addHook('beforeDestroy', async (_row, { transaction }) => {
              await docs.model.update(
                { filename: 'changed-in-db.txt' },
                { where: { id: 1 }, hooks: false, transaction },
              );
            });
            await expect(
              exercise((handle, transaction) => journal.assertNativeEventMatches(handle, native, transaction)),
            ).rejects.toThrow('Native attachment event does not match its prepared intent');
            expect((await docs.model.findByPk(1)).getDataValue('filename')).toBe('receipt.txt');
            expect(await fs.readFile(location())).toEqual(bytes);
          });

          it('does not imply absence or cleanup permission when a hook recreates the original key', async () => {
            docs.model.addHook('afterDestroy', async (_row, { transaction }) => {
              await docs.repository.create({
                values: {
                  id: 1,
                  tenantId: 'B',
                  path: 'old/tenants/H',
                  filename: 'receipt.txt',
                  storageId: 18,
                  size: bytes.length,
                },
                transaction,
              });
            });
            await exercise((handle, transaction) => journal.assertNativeEventMatches(handle, native, transaction));
            expect(await docs.model.count()).toBe(3);
            expect(await events.model.count()).toBe(1);
            expect(await fs.readFile(location())).toEqual(bytes);
          });

          it('does not substitute a different registered source collection', async () => {
            const alias = db.collection({
              name: 'documents_alias',
              schema: 'public',
              template: 'file',
              timestamps: false,
              fields: [
                { name: 'id', type: 'integer', primaryKey: true },
                ...['tenantId', 'path', 'filename'].map((name) => ({ name, type: 'string' })),
                { name: 'storageId', type: 'integer' },
                { name: 'size', type: 'integer' },
              ],
            });
            await alias.model.sync();
            const alternate = new files.AttachmentRemovalNativeCapture(alias, events);
            await expect(
              exercise((handle, transaction) => journal.assertNativeEventMatches(handle, alternate, transaction)),
            ).rejects.toThrow('Native removal event source or operation is unavailable');
            expect(await docs.model.count()).toBe(3);
          });

          it.each(['transaction', 'table', 'key', 'owner', 'location', 'extra', 'version'])(
            'rejects a native event with different %s and rolls back the fixture DELETE',
            async (change) => {
              await expect(
                exercise(async (handle, transaction) => {
                  const row = await events.model.findByPk(handle.id, { transaction });
                  const payload = row.getDataValue('payload');
                  if (change === 'transaction') payload.transactionId = '0';
                  if (change === 'table') payload.source.oid = '0';
                  if (change === 'key') payload.record.key = '2';
                  if (change === 'owner') payload.record.tenantId = 'H';
                  if (change === 'location') payload.record.filename = 'another.txt';
                  if (change === 'extra') payload.extra = 'unrecognized';
                  if (change === 'version') payload.schemaVersion = 9;
                  await events.model.update({ payload }, { where: { id: handle.id }, transaction });
                  await journal.assertNativeEventMatches(handle, native, transaction);
                }),
              ).rejects.toThrow('Native attachment event does not match its prepared intent');
              expect(await docs.model.count()).toBe(3);
              expect(await intents.model.count()).toBe(0);
              expect(await events.model.count()).toBe(0);
              expect(await fs.readFile(location())).toEqual(bytes);
            },
          );

          it('rejects a changed persisted intent rather than trusting its public identifier', async () => {
            await expect(
              exercise(async (handle, transaction) => {
                await intents.model.update(
                  { payload: { state: 'completed' } },
                  { where: { id: handle.id }, transaction },
                );
                await journal.assertNativeEventMatches(handle, native, transaction);
              }),
            ).rejects.toThrow('Removal intent no longer matches its original preparation');
            expect(await docs.model.count()).toBe(3);
          });

          it('refuses a reconstructed handle even when its id matches the real intent', async () => {
            await expect(
              exercise((handle, transaction) =>
                journal.assertNativeEventMatches({ id: handle.id }, native, transaction),
              ),
            ).rejects.toThrow('Original removal intent handle is unavailable');
            expect(await docs.model.count()).toBe(3);
          });

          it('does not reuse a committed preparation in a later transaction', async () => {
            const handle = await prepare(await context(1, {}, 'destroy'), persist);
            await expect(
              db.sequelize.transaction(async (transaction) => {
                await markedDelete(transaction, handle.id);
                await journal.assertNativeEventMatches(handle, native, transaction);
              }),
            ).rejects.toThrow('Original removal intent transaction is unavailable');
            expect(await docs.model.count()).toBe(3);
            expect(await events.model.count()).toBe(0);
            expect(await intents.model.count()).toBe(1);
          });

          it('refuses missing native evidence even though preparation and the DELETE succeeded', async () => {
            await expect(
              exercise(async (handle, transaction) => {
                await events.model.destroy({ where: { id: handle.id }, transaction });
                await journal.assertNativeEventMatches(handle, native, transaction);
              }),
            ).rejects.toThrow('Native removal event is unavailable');
            expect(await docs.model.count()).toBe(3);
          });

          it('rechecks the actual capture function when consuming evidence', async () => {
            await expect(
              exercise(async (handle, transaction) => {
                await db.sequelize.query(`ALTER FUNCTION ${native.functionName}() SECURITY DEFINER`, { transaction });
                await journal.assertNativeEventMatches(handle, native, transaction);
              }),
            ).rejects.toThrow('Native removal capture installation is unavailable or changed');
            expect(await docs.model.count()).toBe(3);
          });

          it.each(['trigger', 'rls', 'rule'])(
            'refuses evidence table %s behavior even if it currently preserves payloads',
            async (change) => {
              if (change === 'trigger')
                await db.sequelize.query(`
              CREATE FUNCTION tamper_native_evidence() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
              CREATE TRIGGER custom_evidence BEFORE INSERT ON attachment_removal_events FOR EACH ROW
                EXECUTE FUNCTION tamper_native_evidence();
            `);
              else if (change === 'rls')
                await db.sequelize.query('ALTER TABLE attachment_removal_events ENABLE ROW LEVEL SECURITY');
              else
                await db.sequelize.query(
                  'CREATE RULE native_evidence_no_insert AS ON INSERT TO attachment_removal_events DO INSTEAD NOTHING',
                );
              await expect(
                exercise((handle, transaction) => journal.assertNativeEventMatches(handle, native, transaction)),
              ).rejects.toThrow('Native removal evidence has unsupported database behavior');
              expect(await docs.model.count()).toBe(3);
              expect(await fs.readFile(location())).toEqual(bytes);
            },
          );
        });
      });

      it('binds the original storage and location to an owned actual record without deleting anything', async () => {
        const ctx = await context(1, { fields: [] }, 'destroy');
        docs.options.storage = 'missing-new-upload-setting';
        const result = await prepare(ctx, async (proof) => {
          expect(proof.collection).toBe(docs);
          expect(proof.record).toMatchObject({ key: 1, path: 'old/tenants/H', filename: 'receipt.txt', storageId: 18 });
          expect(proof.storage).toMatchObject({ id: 18, path: 'new-upload-path', options: { documentRoot: root } });
          expect(proof.retainContent).toBe(false);
          await proof.assertCurrent();
          return 'prepared-only';
        });
        expect(result).toBe('prepared-only');
        expect(await docs.model.count()).toBe(3);
        expect(await fs.readFile(location())).toEqual(bytes);
      });

      it.each([2, 3])('does not prepare a visible-only or hidden attachment %s', async (key) => {
        let consumed = false;
        await expect(
          prepare(await context(key, {}, 'destroy'), async () => {
            consumed = true;
          }),
        ).rejects.toThrow();
        expect(consumed).toBe(false);
        expect(await fs.readFile(location())).toEqual(bytes);
      });

      it.each(['decision', 'location', 'policy'])(
        'rolls back consumer database work and preserves bytes after %s drift',
        async (kind) => {
          const ctx = await context(1, {}, 'destroy');
          await expect(
            prepare(ctx, async (proof) => {
              await docs.model.update(
                { viewable: true },
                { where: { id: 1 }, transaction: proof.transaction, hooks: false },
              );
              if (kind === 'decision') Object.assign(ctx.permission as object, { can: false, skip: false });
              if (kind === 'location')
                await docs.model.update(
                  { path: 'changed' },
                  { where: { id: 1 }, transaction: proof.transaction, hooks: false },
                );
              if (kind === 'policy')
                await db
                  .getRepository('storages')
                  .update({ filterByTk: 18, values: { paranoid: true }, transaction: proof.transaction });
            }),
          ).rejects.toThrow();
          const row = await docs.model.findByPk(1);
          expect(row.getDataValue('viewable')).toBe(false);
          expect(row.getDataValue('path')).toBe('old/tenants/H');
          expect((await db.getRepository('storages').findOne({ filterByTk: 18 })).getDataValue('paranoid')).toBe(false);
          expect(await fs.readFile(location())).toEqual(bytes);
        },
      );

      it('preserves the original storage retention requirement and detaches returned configuration', async () => {
        await db.getRepository('storages').update({ filterByTk: 18, values: { paranoid: true } });
        const ctx = await context(1, {}, 'destroy');
        let assertExpired: () => Promise<void>;
        await prepare(ctx, async (proof) => {
          assertExpired = proof.assertCurrent;
          proof.storage.paranoid = false;
          expect(proof.retainContent).toBe(true);
          expect(proof.storage.paranoid).toBe(true);
        });
        await expect(assertExpired!()).rejects.toThrow();
        expect(await fs.readFile(location())).toEqual(bytes);
      });

      it('rechecks the final destroy decision after awaiting the actual storage lookup', async () => {
        const ctx = await context(1, {}, 'destroy');
        const model = db.getCollection('storages').model;
        const find = model.findAll;
        vi.spyOn(model, 'findAll').mockImplementationOnce(async function (options) {
          const rows = await find.call(this, options);
          Object.assign(ctx.permission as object, { can: false, skip: false });
          return rows;
        });
        let consumed = false;
        await expect(
          prepare(ctx, async () => {
            consumed = true;
          }),
        ).rejects.toThrow();
        expect(consumed).toBe(false);
        expect(await fs.readFile(location())).toEqual(bytes);
      });

      it('does not mistake a visibility-only download proof for a destroy preparation', async () => {
        const entry = handler.captureAttachment(await context(2), { tenantId: 'B', roleName: 'reader', userId: 28 });
        let consumed = false;
        await expect(
          db.sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE }, (transaction) =>
            files.withAuthorizedAttachmentRemovalStorage(
              entry as unknown as files.AuthorizedAttachmentRemovalEntry,
              transaction,
              async () => {
                consumed = true;
              },
            ),
          ),
        ).rejects.toThrow('Attachment removal proof does not match');
        expect(consumed).toBe(false);
        expect(await fs.readFile(location())).toEqual(bytes);
      });
    });

    it.each([1, 2])('reads authorized record %s using its original storage and directory', async (key) => {
      let opened: FileHandle;
      const ctx = await context(key);
      expect(
        await read(ctx, async (handle) => {
          opened = handle;
          return handle.readFile();
        }),
      ).toEqual(bytes);
      await expect(opened!.stat()).rejects.toThrow();
      expect((await docs.model.findByPk(key)).getDataValue('tenantId')).toBe(key === 1 ? 'B' : 'H');
      expect(await fs.readdir(root)).toEqual(['old']);
    });

    it.each([
      { key: 3, grant: { fields } },
      { key: 2, grant: { fields, filter: { id: 1 } } },
      { key: 2, grant: { fields: ['id'] } },
    ])('refuses inaccessible content before storage rendering (%j)', async ({ key, grant }) => {
      let consumed = false;
      await expect(
        read(await context(key, grant), async () => {
          consumed = true;
        }),
      ).rejects.toThrow();
      expect(consumed).toBe(false);
      expect(rendered).toBe(false);
    });

    it('carries the actual registered collection with the record proof', async () => {
      const entry = handler.captureAttachment(await context(), { tenantId: 'B', roleName: 'reader', userId: 28 });
      await entry.withRecord(async (proof) => {
        expect(proof.collection).toBe(docs);
        await proof.assertCurrent();
      });
    });

    it.each(['role', 'visibility', 'location', 'storage', 'mapping'])(
      'refuses a %s change while opening the actual file and closes the handle',
      async (change) => {
        const ctx = await context();
        const actualOpen = fs.open.bind(fs);
        let opened: FileHandle | undefined;
        let consumed = false;
        vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
          opened = await actualOpen(...args);
          if (change === 'role') (ctx.permission as { parsedParams: { fields: string[] } }).parsedParams.fields = [];
          if (change === 'visibility') await docs.model.update({ viewable: false }, { where: { id: 2 } });
          if (change === 'location') await docs.model.update({ filename: 'different.txt' }, { where: { id: 2 } });
          if (change === 'storage')
            await db.getCollection('storages').model.update({ baseUrl: '/changed' }, { where: { id: 18 } });
          if (change === 'mapping') docs.options.template = 'general';
          return opened;
        });
        await expect(
          read(ctx, async () => {
            consumed = true;
          }),
        ).rejects.toThrow();
        expect(consumed).toBe(false);
        expect(opened).toBeDefined();
        await expect(opened!.stat()).rejects.toThrow();
        expect(await fs.readFile(location())).toEqual(bytes);
      },
    );

    it('refuses an async environment renderer before opening content', async () => {
      let consumed = false;
      await expect(
        read(
          await context(),
          async () => {
            consumed = true;
          },
          (raw) => Promise.resolve(raw),
        ),
      ).rejects.toThrow();
      expect(consumed).toBe(false);
    });

    it('closes the actual handle when the awaited consumer fails', async () => {
      let opened: FileHandle;
      const failure = new Error('consumer failed');
      await expect(
        read(await context(), async (handle) => {
          opened = handle;
          throw failure;
        }),
      ).rejects.toBe(failure);
      await expect(opened!.stat()).rejects.toThrow();
    });

    it('keeps a read handle open until awaited chunked consumption completes', async () => {
      const payload = Buffer.alloc(2 * 1024 * 1024, 37);
      await fs.writeFile(location(), payload);
      await docs.model.update({ size: payload.length }, { where: { id: 2 } });
      let opened: FileHandle;
      let count = 0;
      let largest = 0;
      await read(await context(), async (handle) => {
        opened = handle;
        for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 65536 })) {
          count += chunk.length;
          largest = Math.max(largest, chunk.length);
          expect(chunk[0]).toBe(37);
        }
      });
      expect(count).toBe(2 * 1024 * 1024);
      expect(largest).toBeLessThanOrEqual(65536);
      await expect(opened!.stat()).rejects.toThrow();
    });

    describe('explicit HTTP sender', () => {
      async function overHttp(
        ctx: Awaited<ReturnType<typeof context>>,
        exercise: (url: string, started: Promise<ServerResponse>) => Promise<void>,
        prepare?: (response: ServerResponse) => void,
      ) {
        let failure: unknown;
        let finish: () => void;
        let start: (response: ServerResponse) => void;
        const finished = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const started = new Promise<ServerResponse>((resolve) => {
          start = resolve;
        });
        const entry = handler.captureAttachment(ctx, { tenantId: 'B', roleName: 'reader', userId: 28 });
        const server = createServer(async (_request, response) => {
          start(response);
          try {
            prepare?.(response);
            await files.sendAuthorizedLocalAttachment(entry, (raw) => raw, response);
          } catch (error) {
            failure = error;
            if (!response.headersSent && !response.destroyed) {
              response.statusCode = 403;
              response.end('denied');
            }
          } finally {
            finish();
          }
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing loopback test address');
        try {
          await exercise(`http://127.0.0.1:${address.port}/fixture-download`, started);
          await finished;
          return failure;
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        }
      }

      it('sends authorized bytes over real HTTP with private non-cacheable download headers', async () => {
        let opened: FileHandle;
        const actualOpen = fs.open.bind(fs);
        vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
          opened = await actualOpen(...args);
          return opened;
        });
        expect(
          await overHttp(await context(), async (url) => {
            const response = await fetch(url, { headers: { 'if-none-match': 'any-old-cache-entry' } });
            expect(response.status).toBe(200);
            expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
            expect(response.headers.get('cache-control')).toBe('private, no-store');
            expect(response.headers.get('content-type')).toBe('application/octet-stream');
            expect(response.headers.get('content-disposition')).toBe('attachment');
            expect(response.headers.get('x-content-type-options')).toBe('nosniff');
            expect(response.headers.get('etag')).toBeNull();
          }),
        ).toBeUndefined();
        await expect(opened!.stat()).rejects.toThrow();
      });

      it.each(['range', 'HEAD'])('does not stream unsupported %s requests', async (kind) => {
        expect(
          await overHttp(await context(), async (url) => {
            const response = await fetch(
              url,
              kind === 'HEAD' ? { method: 'HEAD' } : { headers: { range: 'bytes=0-1' } },
            );
            expect(response.status).toBe(403);
            expect(await response.text()).not.toContain(bytes.toString());
          }),
        ).toBeInstanceOf(Error);
      });

      it('clears stale length, compression and cache headers before sending the actual file', async () => {
        expect(
          await overHttp(
            await context(),
            async (url) => {
              const response = await fetch(url);
              expect(response.status).toBe(200);
              expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
              for (const header of ['content-length', 'content-encoding', 'content-range', 'etag', 'last-modified'])
                expect(response.headers.get(header)).toBeNull();
            },
            (response) => {
              response.setHeader('Content-Length', '1');
              response.setHeader('Content-Encoding', 'gzip');
              response.setHeader('Content-Range', 'bytes 0-0/1');
              response.setHeader('ETag', 'stale');
              response.setHeader('Last-Modified', 'Wed, 01 Jan 2020 00:00:00 GMT');
            },
          ),
        ).toBeUndefined();
      });

      it('sends an authorized empty file without hanging or bypassing authorization', async () => {
        await fs.writeFile(location(), Buffer.alloc(0));
        await docs.model.update({ size: 0 }, { where: { id: 2 } });
        expect(
          await overHttp(await context(), async (url) => {
            const response = await fetch(url);
            expect(response.status).toBe(200);
            expect((await response.arrayBuffer()).byteLength).toBe(0);
            expect(response.headers.get('cache-control')).toBe('private, no-store');
          }),
        ).toBeUndefined();
      });

      it.each([
        { key: 3, grant: { fields } },
        { key: 2, grant: { fields, filter: { id: 1 } } },
      ])('does not send private bytes for an inaccessible record (%j)', async ({ key, grant }) => {
        expect(
          await overHttp(await context(key, grant), async (url) => {
            const response = await fetch(url);
            expect(response.status).toBe(403);
            expect(await response.text()).toBe('denied');
            expect(response.headers.get('content-disposition')).toBeNull();
          }),
        ).toBeInstanceOf(Error);
      });

      it('does not send bytes when visibility is revoked while opening the file', async () => {
        const actualOpen = fs.open.bind(fs);
        let opened: FileHandle;
        vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
          opened = await actualOpen(...args);
          await docs.model.update({ viewable: false }, { where: { id: 2 } });
          return opened;
        });
        expect(
          await overHttp(await context(), async (url) => {
            const response = await fetch(url);
            expect(response.status).toBe(403);
            expect(await response.text()).toBe('denied');
          }),
        ).toBeInstanceOf(Error);
        await expect(opened!.stat()).rejects.toThrow();
      });

      it('closes the file without sending bytes when the client disconnects during opening', async () => {
        const actualOpen = fs.open.bind(fs);
        let opened: FileHandle;
        let reach: () => void;
        let release: () => void;
        const reached = new Promise<void>((resolve) => {
          reach = resolve;
        });
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
          opened = await actualOpen(...args);
          reach();
          await released;
          return opened;
        });
        expect(
          await overHttp(await context(), async (url, started) => {
            const request = get(url);
            request.on('error', () => {});
            try {
              await reached;
              const response = await started;
              const closed = once(response, 'close');
              request.destroy();
              await closed;
            } finally {
              request.destroy();
              release();
            }
          }),
        ).toBeInstanceOf(Error);
        await expect(opened!.stat()).rejects.toThrow();
      });

      it('closes an in-progress read after the client aborts a large download', async () => {
        const payload = Buffer.alloc(8 * 1024 * 1024, 37);
        await fs.writeFile(location(), payload);
        await docs.model.update({ size: payload.length }, { where: { id: 2 } });
        const actualOpen = fs.open.bind(fs);
        let opened: FileHandle;
        let received = 0;
        vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
          opened = await actualOpen(...args);
          return opened;
        });
        expect(
          await overHttp(
            await context(),
            (url) =>
              new Promise<void>((resolve, reject) => {
                const request = get(url, (response) => {
                  response.once('data', (chunk) => {
                    received += chunk.length;
                    response.destroy();
                    request.destroy();
                    resolve();
                  });
                  response.on('error', (error) => {
                    if (!received) reject(error);
                  });
                });
                request.on('error', (error) => {
                  if (!received) reject(error);
                });
              }),
          ),
        ).toBeInstanceOf(Error);
        expect(received).toBeGreaterThan(0);
        expect(received).toBeLessThan(payload.length);
        await expect(opened!.stat()).rejects.toThrow();
        expect((await fs.stat(location())).size).toBe(payload.length);
      });

      it('completes a chunked large download while honoring a paused client', async () => {
        const payload = Buffer.alloc(8 * 1024 * 1024, 37);
        await fs.writeFile(location(), payload);
        await docs.model.update({ size: payload.length }, { where: { id: 2 } });
        let received = 0;
        let largest = 0;
        const hash = createHash('sha256');
        expect(
          await overHttp(
            await context(),
            (url) =>
              new Promise<void>((resolve, reject) => {
                const request = get(url, (response) => {
                  response.on('data', (chunk) => {
                    received += chunk.length;
                    largest = Math.max(largest, chunk.length);
                    hash.update(chunk);
                    response.pause();
                    setImmediate(() => response.resume());
                  });
                  response.on('end', resolve);
                  response.on('error', reject);
                });
                request.on('error', reject);
              }),
          ),
        ).toBeUndefined();
        expect(received).toBe(payload.length);
        expect(largest).toBeLessThanOrEqual(128 * 1024);
        expect(hash.digest('hex')).toBe(createHash('sha256').update(payload).digest('hex'));
      });
    });
  },
);

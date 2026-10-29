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
      db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
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
            // Test fixture only: the production deletion executor and final G contract remain unimplemented.
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

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
                  async function observer() {
                    const other = isolatedPostgresDatabase(postgresUrl!);
                    try {
                      other.collection(storageDefinition);
                      const source = other.collection({ ...docs.options });
                      const intent = other.collection({ ...intents.options });
                      const event = other.collection({ ...events.options });
                      return {
                        db: other,
                        inspector: new files.AttachmentRemovalCompletionInspector(db, source, intent, event),
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

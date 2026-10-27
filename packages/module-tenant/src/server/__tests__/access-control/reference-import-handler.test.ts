import { createRequire } from 'node:module';
import { ACL, Resourcer, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { AccessRootImportHandler } from '../../access-control/root-import-handler';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const xlsx = createRequire(new URL('../../../../../plugin-action-import/package.json', import.meta.url))('node-xlsx');
const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const projectIdentity = { ...mainIdentity, collectionName: 'projects', collectionKey: 'projects-key' };

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])(
  'authorized reference spreadsheet import (%s)',
  (dialect) => {
    let db: Database;
    let docs: Collection;
    let projects: Collection;
    let store: AccessConfigStore;
    let adapter: AccessAclScopeAdapter;
    let handler: AccessRootImportHandler;
    const identity = (collection: Collection) => (collection === docs ? mainIdentity : projectIdentity);
    const actor = () => ({ tenantId: 'B', userId: 28, roleName: 'importer' });
    const pg = (name: string, run: () => Promise<void>) => it.runIf(dialect === 'postgres')(name, run);
    const dataRows = [
      ['First', 'Visible', '12'],
      ['Second', 'Owned', '23'],
      ['Third', 'Legacy', '0'],
    ];
    const upload = (
      data = dataRows,
      columns = [
        { dataIndex: ['name'], defaultTitle: 'Name' },
        { dataIndex: ['project', 'name'], defaultTitle: 'Project' },
        { dataIndex: ['amount'], defaultTitle: 'Amount' },
      ],
    ) => ({
      buffer: xlsx.build([{ name: 'Import', data: [columns.map((column) => column.defaultTitle), ...data] }]),
      columns,
    });
    const rows = async () => (await docs.model.findAll({ order: [['id', 'ASC']] })).map((record) => record.get());
    const targets = async () =>
      (await projects.model.findAll({ order: [['id', 'ASC']] })).map((record) => record.get());

    beforeEach(async () => {
      db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
      await seedConfigStore(db);
      await seedAclScopes(db);
      projects = db.collection({
        name: 'projects',
        timestamps: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true },
          { name: 'name', type: 'string' },
          { name: 'tenantId', type: 'string' },
        ],
      });
      docs = db.collection({
        name: 'documents',
        timestamps: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true, autoIncrement: true },
          { name: 'name', type: 'string' },
          { name: 'amount', type: 'integer', defaultValue: 10 },
          { name: 'tenantId', type: 'string' },
          { name: 'project', type: 'belongsTo', target: 'projects', foreignKey: 'projectId' },
        ],
      });
      const tenants = db.collection({
        name: 'tenants',
        timestamps: false,
        autoGenId: false,
        fields: [
          { name: 'id', type: 'string', primaryKey: true },
          { name: 'enabled', type: 'boolean' },
        ],
      });
      await tenants.model.sync();
      await tenants.model.create({ id: 'B', enabled: true });
      await projects.model.sync();
      await docs.model.sync();
      await projects.model.bulkCreate([
        { id: 101, name: 'Visible', tenantId: 'H' },
        { id: 102, name: 'Hidden', tenantId: 'C' },
        { id: 103, name: 'Owned', tenantId: 'B' },
        { id: 104, name: 'Legacy', tenantId: null },
      ]);
      await db.getRepository('collections').create({ values: { name: 'projects', key: 'projects-key' } });
      store = new AccessConfigStore(db, (key) =>
        resolveModelMetadata(db.getCollection(key.collectionName), {
          resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
        }),
      );
      const target = configFor(ownerCondition);
      target.rules.push({
        ...configFor(
          {
            type: 'any',
            children: [
              {
                type: 'compare',
                operator: 'eq',
                left: { type: 'field', path: 'name' },
                right: { type: 'literal', value: 'Visible' },
              },
              { type: 'isNull', operand: { type: 'field', path: 'tenantId' } },
            ],
          },
          'visibility',
        ).rules[0],
        id: 'visible',
      });
      await store.save(mainIdentity, { ...configFor(ownerCondition), revision: 0 }, { userId: 28 });
      await store.save(projectIdentity, { ...target, revision: 0 }, { userId: 28 });
      adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
      handler = new AccessRootImportHandler(
        db,
        adapter,
        new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection))),
        identity,
      );
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      try {
        if (dialect === 'postgres') {
          await db?.sequelize.drop({ cascade: true });
          await db?.sequelize.query('DROP FUNCTION IF EXISTS reject_reference_import_commit()');
        }
      } finally {
        await db?.close();
      }
    });

    async function context(
      resource = 'documents',
      actionName = 'importXlsx',
      grant: object = { fields: ['name', 'amount', 'project'] },
      params: object = {},
    ) {
      const acl = new ACL();
      acl.setAvailableAction('importXlsx', { type: 'new-data' });
      acl.setAvailableAction('list', {});
      acl.define({ role: 'importer' }).grantAction(`${resource}:${actionName}`, grant);
      const router = new Resourcer();
      router.define({ name: resource, actions: { importXlsx: {}, list: {} } });
      const action = router.getAction(resource, actionName).clone();
      Object.assign(action, { resourceName: resource, actionName });
      action.mergeParams({ resourceName: resource, actionName, ...params });
      const ctx = {
        db,
        action,
        state: { currentRole: 'importer', currentUser: { id: 28 } },
        get: () => '+08:00',
        logger: { info: () => {} },
        throw: (status: number) => {
          throw new Error(String(status));
        },
        permission: undefined as unknown,
        body: 'unchanged' as unknown,
      };
      await adapter.prepare(ctx, [mainIdentity, projectIdentity]);
      await acl.middleware()(ctx as never, async () => {});
      return ctx;
    }
    const authorize = () => context('projects', 'list', { fields: ['id', 'name'] });

    pg('imports multiple references with scalar columns on both sides of the association column', async () => {
      const before = await targets();
      const ctx = await context();
      await handler.handle(ctx, actor(), upload(), authorize);
      expect(ctx.body).toEqual({ rows: [], successCount: 3, failureCount: 0 });
      expect(await rows()).toMatchObject([
        { name: 'First', projectId: 101, amount: 12, tenantId: 'B' },
        { name: 'Second', projectId: 103, amount: 23, tenantId: 'B' },
        { name: 'Third', projectId: 104, amount: 0, tenantId: 'B' },
      ]);
      expect(await targets()).toEqual(before);
    });

    it.runIf(dialect === 'sqlite')(
      'rejects reference import before target decisions on an unsupported database',
      async () => {
        const ctx = await context();
        let called = false;
        await expect(
          handler.handle(ctx, actor(), upload(), async () => {
            called = true;
            return authorize();
          }),
        ).rejects.toMatchObject({ code: 'UNSUPPORTED_ACCESS_MUTATION' });
        expect(called).toBe(false);
        expect(await rows()).toEqual([]);
      },
    );

    it('keeps references disabled without a server-selected target authorizer', async () => {
      const ctx = await context();
      await expect(handler.handle(ctx, actor(), upload())).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(await rows()).toEqual([]);
    });

    pg('rejects one hidden reference without retaining any earlier rows', async () => {
      const ctx = await context();
      await expect(
        handler.handle(
          ctx,
          actor(),
          upload([
            ['First', 'Visible', '12'],
            ['Second', 'Hidden', '23'],
          ]),
          authorize,
        ),
      ).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      expect(await rows()).toEqual([]);
      expect(ctx.body).toBe('unchanged');
    });

    pg('does not use target visibility to grant ownership of the imported sources', async () => {
      await store.save(
        mainIdentity,
        { ...configFor({ type: 'constant', value: true }, 'visibility'), revision: 1 },
        { userId: 28 },
      );
      const ctx = await context();
      await expect(handler.handle(ctx, actor(), upload(), authorize)).rejects.toMatchObject({
        code: 'ACCESS_RECORD_UNAVAILABLE',
      });
      expect(await rows()).toEqual([]);
    });

    pg('requires the source import field grant before requesting any target decision', async () => {
      const ctx = await context('documents', 'importXlsx', { fields: ['name', 'amount'] });
      let called = false;
      await expect(
        handler.handle(ctx, actor(), upload(), async () => {
          called = true;
          return authorize();
        }),
      ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(called).toBe(false);
      expect(await rows()).toEqual([]);
    });

    pg('checks target field permissions before constructing a source scalar parser', async () => {
      let parsed = false;
      const Parser = db.fieldValueParsers.get('integer');
      db.registerFieldValueParsers({
        integer: class extends Parser {
          async setValue(value: unknown) {
            parsed = true;
            await super.setValue(value);
          }
        },
      });
      const ctx = await context();
      await expect(
        handler.handle(ctx, actor(), upload(), () => context('projects', 'list', { fields: ['id'] })),
      ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(parsed).toBe(false);
      expect(await rows()).toEqual([]);
    });

    pg('rejects ambiguous target names instead of linking the first readable record', async () => {
      await projects.model.create({ id: 105, name: 'Owned', tenantId: 'B' });
      const ctx = await context();
      await expect(handler.handle(ctx, actor(), upload(), authorize)).rejects.toMatchObject({
        code: 'INVALID_ACCESS_MUTATION',
      });
      expect(await rows()).toEqual([]);
    });

    pg('keeps blank references null without moving scalar cell positions', async () => {
      const ctx = await context();
      await handler.handle(ctx, actor(), upload([['Empty', null, '18']]), authorize);
      expect(await rows()).toMatchObject([{ name: 'Empty', projectId: null, amount: 18, tenantId: 'B' }]);
    });

    pg('keeps two association columns and their distinct foreign keys bound to each input row', async () => {
      docs.setField('secondaryProject', { type: 'belongsTo', target: 'projects', foreignKey: 'secondaryProjectId' });
      await docs.model.sync({ alter: true });
      const ctx = await context('documents', 'importXlsx', {
        fields: ['name', 'project', 'secondaryProject', 'amount'],
      });
      await handler.handle(
        ctx,
        actor(),
        upload(
          [
            ['First', 'Visible', '12', '103'],
            ['Second', 'Owned', '23', '104'],
          ],
          [
            { dataIndex: ['name'], defaultTitle: 'Name' },
            { dataIndex: ['project', 'name'], defaultTitle: 'Project' },
            { dataIndex: ['amount'], defaultTitle: 'Amount' },
            { dataIndex: ['secondaryProject', 'id'], defaultTitle: 'Secondary' },
          ],
        ),
        authorize,
      );
      expect(await rows()).toMatchObject([
        { name: 'First', amount: 12, projectId: 101, secondaryProjectId: 103, tenantId: 'B' },
        { name: 'Second', amount: 23, projectId: 103, secondaryProjectId: 104, tenantId: 'B' },
      ]);
    });

    pg('runs the target lookup parser inside the serializable import transaction', async () => {
      const Parser = db.fieldValueParsers.get('string');
      db.registerFieldValueParsers({
        string: class extends Parser {
          async setValue(value: unknown) {
            if (this.field.collection === projects) {
              const [rows] = await db.sequelize.query("SELECT current_setting('transaction_isolation') AS isolation", {
                transaction: this.ctx.transaction,
              });
              if ((rows[0] as { isolation: string }).isolation !== 'serializable') {
                this.errors.push('Lookup parser was outside the import transaction');
                return;
              }
            }
            await super.setValue(value);
          }
        },
      });
      const ctx = await context();
      await handler.handle(ctx, actor(), upload(), authorize);
      expect(await rows()).toMatchObject([{ projectId: 101 }, { projectId: 103 }, { projectId: 104 }]);
    });

    pg('rechecks source role conditions after all imported rows are persisted', async () => {
      const ctx = await context('documents', 'importXlsx', {
        fields: ['name', 'amount', 'project'],
        filter: { name: 'First' },
      });
      await expect(handler.handle(ctx, actor(), upload(), authorize)).rejects.toMatchObject({
        code: 'ACCESS_RECORD_UNAVAILABLE',
      });
      expect(await rows()).toEqual([]);
    });

    pg('runs a source scalar parser in the same serializable import transaction', async () => {
      const Parser = db.fieldValueParsers.get('integer');
      db.registerFieldValueParsers({
        integer: class extends Parser {
          async setValue(value: unknown) {
            const [rows] = await db.sequelize.query("SELECT current_setting('transaction_isolation') AS isolation", {
              transaction: this.ctx.transaction,
            });
            if ((rows[0] as { isolation: string }).isolation !== 'serializable')
              this.errors.push('Parser was outside the import transaction');
            else await super.setValue(value);
          }
        },
      });
      const ctx = await context();
      await handler.handle(ctx, actor(), upload(), authorize);
      expect(await rows()).toMatchObject([{ amount: 12 }, { amount: 23 }, { amount: 0 }]);
    });

    pg('rolls back every source when a later insert throws the original failure', async () => {
      const failure = new Error('Second imported row failed');
      docs.model.addHook('beforeCreate', 'fail-import', (record) => {
        if (record.get('name') === 'Second') throw failure;
      });
      const ctx = await context();
      await expect(handler.handle(ctx, actor(), upload(), authorize)).rejects.toBe(failure);
      expect(await rows()).toEqual([]);
      expect(ctx.body).toBe('unchanged');
    });

    pg('rolls back source and target changes when a hook makes a selected target unreadable', async () => {
      docs.model.addHook('afterCreate', 'hide-import-target', async (_row, options) => {
        await projects.model.update(
          { name: 'Hidden now', tenantId: 'C' },
          { where: { id: 101 }, transaction: options.transaction },
        );
      });
      const before = await targets();
      const ctx = await context();
      await expect(handler.handle(ctx, actor(), upload(), authorize)).rejects.toMatchObject({
        code: 'ACCESS_RECORD_UNAVAILABLE',
      });
      expect(await rows()).toEqual([]);
      expect(await targets()).toEqual(before);
    });

    pg('maps actual commit serialization failure without success or commit notification', async () => {
      await db.sequelize.query(
        "CREATE FUNCTION reject_reference_import_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'reference import commit conflict' USING ERRCODE = '40001'; RETURN NEW; END $$",
      );
      await db.sequelize.query(
        'CREATE CONSTRAINT TRIGGER reject_reference_import_commit AFTER INSERT ON documents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_reference_import_commit()',
      );
      let notified = false;
      docs.model.addHook('afterCreate', 'notify-import', (_row, options) => {
        options.transaction!.afterCommit(() => {
          notified = true;
        });
      });
      const ctx = await context();
      await expect(handler.handle(ctx, actor(), upload(), authorize)).rejects.toMatchObject({
        code: 'ACCESS_MUTATION_CONFLICT',
        status: 409,
      });
      expect(await rows()).toEqual([]);
      expect(notified).toBe(false);
      expect(ctx.body).toBe('unchanged');
    });
  },
);

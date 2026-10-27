import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mockServer, supertest, type MockServer } from '@tachybase/test';
import { ACL, Resourcer, type Collection, type Context } from '@tego/server';

import ErrorPlugin from '../../../../../module-error-handler/src/server';
import ImportPlugin from '../../../../../plugin-action-import/src/server';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { AccessRootImportHandler } from '../../access-control/root-import-handler';
import type { AccessRootReadContext } from '../../access-control/root-read-context';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_ENTRY;
const coreAvailable = coreEntry || 'registerActionParamsResolver' in ACL.prototype;
const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const xlsx = createRequire(new URL('../../../../../plugin-action-import/package.json', import.meta.url))('node-xlsx');

/** Real upload, plugin selection, finalized ACL and PostgreSQL; server fixture principals only. */
describe.skipIf(!coreAvailable || !postgresUrl)('tenant reference import over HTTP', () => {
  let app: MockServer;
  let acl: ACL;
  let adapter: AccessAclScopeAdapter;
  let store: AccessConfigStore;
  let unregister: (() => void) | undefined;
  let principal: { tenantId: string; roleName: string; userId: number };
  const identity = (collection: Collection) => ({
    ...mainIdentity,
    collectionName: collection.name,
    collectionKey: collection.name === 'documents' ? mainIdentity.collectionKey : `${collection.name}-key`,
  });
  const identities = () =>
    ['documents', 'projects', 'document_projects'].map((name) => identity(app.db.getCollection(name)));

  beforeEach(async () => {
    const isolated = isolatedPostgresDatabase(postgresUrl!);
    // One connection proves authorization preparation does not borrow another inside the file transaction.
    const database = { ...isolated.options, pool: { max: 1, acquire: 2500 } };
    await isolated.close();
    app = mockServer({ acl: false, registerActions: true, database, resourcer: { prefix: '/api' } });
    const errors = new ErrorPlugin(app, { name: 'test-errors' });
    await errors.beforeLoad();
    await errors.load();
    const db = app.db;
    await seedConfigStore(db);
    await seedAclScopes(db);
    db.collection({
      name: 'projects',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'name', type: 'string' },
        { name: 'tenantId', type: 'string' },
      ],
    });
    db.collection({ name: 'document_projects', timestamps: false });
    db.collection({
      name: 'documents',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true, autoIncrement: true },
        { name: 'name', type: 'string' },
        { name: 'amount', type: 'integer' },
        { name: 'tenantId', type: 'string' },
        { name: 'project', type: 'belongsTo', target: 'projects', foreignKey: 'projectId' },
        {
          name: 'projects',
          type: 'belongsToMany',
          target: 'projects',
          through: 'document_projects',
          foreignKey: 'documentId',
          otherKey: 'targetId',
        },
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
    await db.getCollection('tenants').model.bulkCreate(['B', 'C'].map((id) => ({ id, enabled: true })));
    await db.getCollection('projects').model.bulkCreate([
      { id: 101, name: 'Owned', tenantId: 'B' },
      { id: 102, name: 'Visible', tenantId: 'H' },
      { id: 103, name: 'Hidden', tenantId: 'C' },
      { id: 104, name: 'Legacy', tenantId: null },
    ]);
    await db.getRepository('collections').create({ values: { name: 'projects', key: 'projects-key' } });
    await db
      .getRepository('collections')
      .create({ values: { name: 'document_projects', key: 'document_projects-key' } });
    store = new AccessConfigStore(db, (key) =>
      resolveModelMetadata(db.getCollection(key.collectionName), {
        resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
      }),
    );
    await store.save(mainIdentity, { ...configFor(ownerCondition), revision: 0 }, { userId: 28 });
    const config = configFor(ownerCondition);
    config.rules.push({
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
    await store.save(identity(db.getCollection('projects')), { ...config, revision: 0 }, { userId: 28 });
    const CoreACL = coreEntry ? (await import(/* @vite-ignore */ pathToFileURL(coreEntry).href)).ACL : ACL;
    acl = new CoreACL();
    app.mainDataSource.acl = acl;
    acl.setAvailableAction('importXlsx', { type: 'new-data', allowConfigureFields: true });
    acl.setAvailableAction('list', {});
    acl.define({ role: 'importer' }).grantAction('documents:importXlsx', { fields: ['name', 'project', 'amount'] });
    acl.getRole('importer').grantAction('projects:list', { fields: ['id', 'name'] });
    acl.define({ role: 'creator' }).grantAction('documents:create', {});
    adapter = new AccessAclScopeAdapter(acl, 'main', store, db);
    unregister = adapter.register();
    principal = { tenantId: 'B', roleName: 'importer', userId: 28 };
    app.resourcer.use(
      async (ctx, next) => {
        ctx.state.currentRole = principal.roleName;
        ctx.state.currentTenant = { id: principal.tenantId };
        ctx.state.currentUser = { id: principal.userId };
        ctx.state.accessTestActor = { ...principal };
        await adapter.prepare(ctx, identities());
        try {
          await next();
        } finally {
          adapter.release(ctx);
        }
      },
      { tag: 'reference-import-preparation', after: 'auth' },
    );
    app.resourcer.use(acl.middleware(), { tag: 'reference-import-acl', after: 'reference-import-preparation' });
    const handler = new AccessRootImportHandler(
      db,
      adapter,
      new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection))),
      identity,
    );
    const plugin = new ImportPlugin(app, {
      name: 'test-import',
      importResolver: () => async (ctx: Context & { permission: unknown }) => {
        const decisions: AccessRootReadContext[] = [];
        const authorize = async (collection: Collection) => {
          const router = new Resourcer();
          router.define({ name: collection.name, actions: { list: {} } });
          const action = router.getAction(collection.name, 'list').clone();
          Object.assign(action, { resourceName: collection.name, actionName: 'list' });
          action.mergeParams({ resourceName: collection.name, actionName: 'list' });
          const decision = {
            db,
            action,
            permission: undefined as unknown,
            state: ctx.state,
            get: ctx.get.bind(ctx),
            logger: ctx.logger,
            throw: ctx.throw.bind(ctx),
          };
          decisions.push(decision);
          await adapter.prepare(decision, identities());
          await acl.middleware()(decision as never, async () => {});
          return decision;
        };
        try {
          await handler.handle(
            ctx,
            ctx.state.accessTestActor,
            { buffer: ctx.file.buffer, columns: ctx.request.body.columns },
            authorize,
          );
        } finally {
          decisions.forEach((decision) => adapter.release(decision));
        }
      },
    });
    await plugin.beforeLoad();
    await plugin.load();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    unregister?.();
    unregister = undefined;
    try {
      await app?.db.sequelize.drop({ cascade: true });
    } finally {
      await app?.destroy();
    }
  });
  const request = (
    data: unknown[][] = [
      ['Name', 'Project', 'Amount'],
      ['First', 'Visible', '12'],
      ['Second', 'Legacy', '23'],
    ],
  ) =>
    supertest(app.callback())
      .post('/api/documents:importXlsx')
      .set('x-tenant-id', 'C')
      .attach('file', xlsx.build([{ name: 'Import', data }]), { filename: 'import.xlsx' })
      .field(
        'columns',
        JSON.stringify([
          { dataIndex: ['name'], defaultTitle: 'Name' },
          { dataIndex: ['project', 'name'], defaultTitle: 'Project' },
          { dataIndex: ['amount'], defaultTitle: 'Amount' },
        ]),
      );
  const rows = async () =>
    (await app.db.getCollection('documents').model.findAll({ order: [['id', 'ASC']] })).map((row) => row.get());

  it('commits visible and legacy references without changing their ownership', async () => {
    const before = (await app.db.getCollection('projects').model.findAll({ order: [['id', 'ASC']] })).map((row) =>
      row.get(),
    );
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ data: [], meta: { successCount: 2, failureCount: 0 } });
    expect(await rows()).toMatchObject([
      { name: 'First', projectId: 102, amount: 12, tenantId: 'B' },
      { name: 'Second', projectId: 104, amount: 23, tenantId: 'B' },
    ]);
    expect(
      (await app.db.getCollection('projects').model.findAll({ order: [['id', 'ASC']] })).map((row) => row.get()),
    ).toEqual(before);
  });
  it('does not substitute create permission for import permission', async () => {
    principal.roleName = 'creator';
    expect((await request()).status).toBe(403);
    expect(await rows()).toEqual([]);
  });
  it('rejects an ungranted source association without falling back to the original importer', async () => {
    acl.getRole('importer').grantAction('documents:importXlsx', { fields: ['name', 'amount'] });
    expect((await request()).status).toBe(400);
    expect(await rows()).toEqual([]);
  });
  it('enforces the independent target role condition', async () => {
    acl.getRole('importer').grantAction('projects:list', { fields: ['id', 'name'], filter: { name: 'Owned' } });
    expect((await request()).status).toBe(403);
    expect(await rows()).toEqual([]);
  });
  it('keeps the whole file empty when a later reference is hidden', async () => {
    const response = await request([
      ['Name', 'Project', 'Amount'],
      ['First', 'Visible', '12'],
      ['Second', 'Hidden', '23'],
    ]);
    expect(response.status).toBe(403);
    expect(await rows()).toEqual([]);
  });
  it('rolls back earlier inserts and propagates a later hook failure', async () => {
    app.db.getCollection('documents').model.addHook('beforeCreate', 'fail-upload', (row) => {
      if (row.get('name') === 'Second') throw new Error('Second reference import insert failed');
    });
    const response = await request();
    expect(response.status).toBe(500);
    expect(response.body.errors[0].message).toContain('Second reference import insert failed');
    expect(await rows()).toEqual([]);
  });
  it('cannot create sources using visibility alone', async () => {
    await store.save(
      mainIdentity,
      { ...configFor({ type: 'constant', value: true }, 'visibility'), revision: 1 },
      { userId: 28 },
    );
    expect((await request()).status).toBe(403);
    expect(await rows()).toEqual([]);
  });

  describe('multi-value selections', () => {
    beforeEach(() => {
      acl
        .getRole('importer')
        .grantAction('documents:importXlsx', { fields: ['name', 'project', 'projects', 'amount'] });
    });
    const linkRequest = (
      selections = ['Owned;Visible', 'Legacy'],
      options: { mixed?: boolean; title?: string } = {},
    ) => {
      const mixed = options.mixed ?? true;
      const columns = [
        { dataIndex: ['projects', 'name'], defaultTitle: 'Projects' },
        { dataIndex: ['name'], defaultTitle: 'Name' },
        ...(mixed ? [{ dataIndex: ['project', 'name'], defaultTitle: 'Project' }] : []),
        { dataIndex: ['amount'], defaultTitle: 'Amount' },
      ];
      const data = [
        columns.map((column) => column.defaultTitle),
        ...selections.map((selection, index) => [
          selection,
          options.title ?? (index === 0 ? 'First' : 'Second'),
          ...(mixed ? ['Visible'] : []),
          String(index + 1),
        ]),
      ];
      return supertest(app.callback())
        .post('/api/documents:importXlsx')
        .set('x-tenant-id', 'C')
        .attach('file', xlsx.build([{ name: 'Import', data }]), { filename: 'import.xlsx' })
        .field('columns', JSON.stringify(columns));
    };
    const links = async () => {
      const values = await rows();
      const stored = await app.db.getCollection('document_projects').model.findAll();
      return values.map((value) => ({
        name: value.name,
        keys: stored
          .filter((link) => link.get('documentId') === value.id)
          .map((link) => link.get('targetId'))
          .sort(),
      }));
    };
    it('imports row-specific links and single references with interleaved scalar columns using one connection', async () => {
      const before = (await app.db.getCollection('projects').model.findAll({ order: [['id', 'ASC']] })).map((row) =>
        row.get(),
      );
      const response = await linkRequest();
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ data: [], meta: { successCount: 2, failureCount: 0 } });
      expect(await rows()).toMatchObject([
        { name: 'First', amount: 1, projectId: 102, tenantId: 'B' },
        { name: 'Second', amount: 2, projectId: 102, tenantId: 'B' },
      ]);
      expect(await links()).toEqual([
        { name: 'First', keys: [101, 102] },
        { name: 'Second', keys: [104] },
      ]);
      expect(
        (await app.db.getCollection('projects').model.findAll({ order: [['id', 'ASC']] })).map((row) => row.get()),
      ).toEqual(before);
    });
    it('imports only multi-value relations and permits explicit empty cells', async () => {
      expect((await linkRequest(['Visible', ''], { mixed: false })).status).toBe(200);
      expect(await links()).toEqual([
        { name: 'First', keys: [102] },
        { name: 'Second', keys: [] },
      ]);
    });
    it('requires the import permission for a multi-value column independently of a single reference', async () => {
      acl.getRole('importer').grantAction('documents:importXlsx', { fields: ['name', 'project', 'amount'] });
      expect((await linkRequest()).status).toBe(400);
      expect(await rows()).toEqual([]);
    });
    it('rejects a later hidden target without committing the first row', async () => {
      expect((await linkRequest(['Visible', 'Legacy;Hidden'])).status).toBe(403);
      expect(await rows()).toEqual([]);
      expect(await app.db.getCollection('document_projects').model.count()).toBe(0);
    });
    it('rejects ambiguous display values instead of linking all matches', async () => {
      await app.db.getCollection('projects').model.create({ id: 105, name: 'Owned', tenantId: 'B' });
      expect((await linkRequest()).status).toBe(400);
      expect(await rows()).toEqual([]);
    });
    it('rolls back all sources and connections after a connection hook throws', async () => {
      let commits = 0;
      app.db.getCollection('documents').model.addHook('afterCreate', 'observe-import-commit', (_row, options) => {
        options.transaction!.afterCommit(() => {
          commits++;
        });
      });
      app.db.getCollection('document_projects').model.addHook('afterBulkCreate', 'reject-second-link', (records) => {
        if (records.some((record) => record.get('targetId') === 104)) throw new Error('Later import link failed');
      });
      const response = await linkRequest();
      expect(response.status).toBe(500);
      expect(response.body.errors[0].message).toContain('Later import link failed');
      expect(await rows()).toEqual([]);
      expect(await app.db.getCollection('document_projects').model.count()).toBe(0);
      expect(commits).toBe(0);
    });
    it('rechecks final target visibility after source insert hooks', async () => {
      app.db.getCollection('documents').model.addHook('afterCreate', 'hide-import-target', async (_row, options) => {
        await app.db
          .getCollection('projects')
          .model.update({ name: 'No longer visible' }, { where: { id: 102 }, transaction: options.transaction });
      });
      expect((await linkRequest(['Visible'], { mixed: false })).status).toBe(403);
      expect(await rows()).toEqual([]);
      expect((await app.db.getCollection('projects').model.findByPk(102))!.get('name')).toBe('Visible');
    });
    it('rejects sources allowed by visibility alone in a multi-value file', async () => {
      await store.save(
        mainIdentity,
        { ...configFor({ type: 'constant', value: true }, 'visibility'), revision: 1 },
        { userId: 28 },
      );
      expect((await linkRequest()).status).toBe(403);
      expect(await rows()).toEqual([]);
    });
    it('applies final target role filters to every selected value', async () => {
      acl.getRole('importer').grantAction('projects:list', { fields: ['id', 'name'], filter: { name: 'Owned' } });
      expect((await linkRequest(['Owned;Visible'], { mixed: false })).status).toBe(403);
      expect(await rows()).toEqual([]);
    });
    it('enforces a combined twenty-field limit before querying targets', async () => {
      const docs = app.db.getCollection('documents');
      const extra = Array.from({ length: 19 }, (_, index) => `secondary${index}`);
      for (const name of extra) docs.setField(name, { type: 'belongsTo', target: 'projects', foreignKey: `${name}Id` });
      await docs.model.sync({ alter: true });
      const names = ['project', 'projects', ...extra];
      acl.getRole('importer').grantAction('documents:importXlsx', { fields: names });
      let reads = 0;
      const targets = app.db.getCollection('projects').model;
      app.db.sequelize.addHook('afterQuery', 'count-target-queries', (options) => {
        if (options.type === 'SELECT' && (options as { model?: typeof targets }).model === targets) reads++;
      });
      const response = await supertest(app.callback())
        .post('/api/documents:importXlsx')
        .attach('file', xlsx.build([{ name: 'Import', data: [names, names.map(() => 'Owned')] }]), {
          filename: 'import.xlsx',
        })
        .field('columns', JSON.stringify(names.map((name) => ({ dataIndex: [name, 'name'], defaultTitle: name }))));
      expect(response.status).toBe(400);
      expect(response.body.errors[0].message).toContain('combined per-row limit');
      expect(reads).toBe(0);
      expect(await rows()).toEqual([]);
    });
    it('keeps whole-database relationship scans out of scalar parsing while retaining write checks', async () => {
      // Observe the real iterator; no metadata or database behavior is replaced.
      const scans = vi.spyOn(app.db.collections, 'values');
      const observed: number[] = [];
      const Parser = app.db.fieldValueParsers.get('string');
      app.db.registerFieldValueParsers({
        string: class extends Parser {
          async setValue(value: unknown) {
            observed.push(scans.mock.calls.length);
            await super.setValue(value);
          }
        },
      });
      const response = await linkRequest(['', ''], { mixed: false });
      expect(response.status).toBe(200);
      expect(observed).toHaveLength(2);
      expect(new Set(observed).size).toBe(1);
      expect(scans.mock.calls.length).toBeGreaterThan(observed[1]);
      expect(await links()).toEqual([
        { name: 'First', keys: [] },
        { name: 'Second', keys: [] },
      ]);
    });
  });
});

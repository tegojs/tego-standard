import { createRequire } from 'node:module';
import { ACL, Resourcer, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import * as imports from '../../access-control/root-import-handler';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const xlsx = createRequire(new URL('../../../../../plugin-action-import/package.json', import.meta.url))('node-xlsx');

describe('finalized scalar tenant import', () => {
  let db: Database;
  let docs: Collection;
  let adapter: AccessAclScopeAdapter;
  let store: AccessConfigStore;
  const auth = () => ({ tenantId: 'B', roleName: 'importer', userId: 28 });
  const identity = (collection: Collection) => ({
    ...mainIdentity,
    collectionName: collection.name,
    collectionKey: collection.name === 'documents' ? mainIdentity.collectionKey : `${collection.name}-key`,
  });
  const file = (
    data: unknown[][] = [
      ['Name', 'Amount'],
      ['First', '12'],
      ['Second', '23'],
    ],
  ) => ({
    buffer: xlsx.build([{ name: 'Import', data }]),
    columns: [
      { dataIndex: ['name'], defaultTitle: 'Name' },
      { dataIndex: ['amount'], defaultTitle: 'Amount' },
    ],
  });
  const rows = async () => (await docs.model.findAll({ order: [['id', 'ASC']] })).map((row) => row.get());
  const handler = () =>
    new imports.AccessRootImportHandler(
      db,
      adapter,
      new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection))),
      identity,
    );

  beforeEach(async () => {
    db = sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    docs = db.collection({
      name: 'documents',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true, autoIncrement: true },
        { name: 'tenantId', type: 'string' },
        { name: 'name', type: 'string', defaultValue: 'Draft' },
        { name: 'amount', type: 'integer', defaultValue: 10 },
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
    await docs.model.sync();
    await tenants.model.sync();
    await tenants.model.bulkCreate(['H', 'B', 'C'].map((id) => ({ id, enabled: true })));
    store = new AccessConfigStore(db, (key) =>
      resolveModelMetadata(db.getCollection(key.collectionName), {
        resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
      }),
    );
    await store.save(mainIdentity, { ...configFor(ownerCondition), revision: 0 }, { userId: 28 });
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db?.close();
  });

  async function context(permission: object | false = {}) {
    const acl = new ACL();
    acl.setAvailableAction('importXlsx', { type: 'new-data', allowConfigureFields: true });
    const role = acl.define({ role: 'importer' });
    if (permission !== false) role.grantAction('documents:importXlsx', permission);
    const router = new Resourcer();
    router.define({ name: 'documents', actions: { importXlsx: {} } });
    const action = router.getAction('documents', 'importXlsx').clone();
    Object.assign(action, { resourceName: 'documents', actionName: 'importXlsx' });
    action.mergeParams({ resourceName: 'documents', actionName: 'importXlsx' });
    const ctx = {
      db,
      action,
      state: { currentRole: 'importer', currentUser: { id: 28, name: 'First' } },
      get: () => '+08:00',
      logger: { info: () => {} },
      throw: (status: number) => {
        throw new Error(String(status));
      },
      permission: undefined as unknown,
      body: 'unchanged' as unknown,
    };
    await adapter.prepare(ctx, [mainIdentity]);
    await acl.middleware()(ctx as never, async () => {});
    return ctx;
  }

  it('imports using its own action grant, typed values and active ownership without a create grant', async () => {
    const ctx = await context({ fields: ['name', 'amount'] });
    await handler().handle(ctx, auth(), file());
    expect(await rows()).toMatchObject([
      { name: 'First', amount: 12, tenantId: 'B' },
      { name: 'Second', amount: 23, tenantId: 'B' },
    ]);
    expect(ctx.body).toEqual({ rows: [], successCount: 2, failureCount: 0 });
  });

  it('rejects a missing import action even when no values have yet been parsed', async () => {
    const ctx = await context();
    Object.assign(ctx.permission, { can: null });
    await expect(handler().handle(ctx, auth(), file())).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await rows()).toEqual([]);
    expect(ctx.body).toBe('unchanged');
  });

  it.each([{ fields: ['name'] }, { blacklist: ['amount'] }, { fields: [] }])(
    'rejects the complete mapping before parsing any cell with grants %j',
    async (permission) => {
      const ctx = await context(permission);
      let parsed = false;
      const Parser = db.fieldValueParsers.get('string');
      db.registerFieldValueParsers({
        string: class extends Parser {
          async setValue(value: unknown) {
            parsed = true;
            await super.setValue(value);
          }
        },
      });
      await expect(handler().handle(ctx, auth(), file())).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(parsed).toBe(false);
      expect(await rows()).toEqual([]);
    },
  );

  it('does not let visibility grant import writes', async () => {
    await store.save(
      mainIdentity,
      { ...configFor({ type: 'constant', value: true }, 'visibility'), revision: 1 },
      { userId: 28 },
    );
    const ctx = await context();
    await expect(handler().handle(ctx, auth(), file())).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await rows()).toEqual([]);
    expect(ctx.body).toBe('unchanged');
  });

  it('applies finalized role conditions to every inserted row and rolls back the entire file', async () => {
    const ctx = await context({ filter: { name: '{{ ctx.state.currentUser.name }}' } });
    await expect(handler().handle(ctx, auth(), file())).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await rows()).toEqual([]);
  });

  it('rolls back earlier rows when a later model hook throws the original error', async () => {
    const failure = new Error('Second import row rejected');
    docs.model.addHook('beforeCreate', 'reject-second', (row) => {
      if (row.get('name') === 'Second') throw failure;
    });
    const ctx = await context();
    await expect(handler().handle(ctx, auth(), file())).rejects.toBe(failure);
    expect(await rows()).toEqual([]);
    expect(ctx.body).toBe('unchanged');
  });

  it('rejects bad numeric input before starting any inserts', async () => {
    const ctx = await context();
    await expect(
      handler().handle(
        ctx,
        auth(),
        file([
          ['Name', 'Amount'],
          ['First', 1],
          ['Second', 'invalid'],
        ]),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await rows()).toEqual([]);
  });

  it.each(['tenantId', 'missing', 'owner.id', 'ownerId'])('rejects unsupported mapping %s', async (name) => {
    docs.setField('owner', { type: 'belongsTo', target: 'tenants', foreignKey: 'ownerId' });
    await docs.model.sync({ alter: true });
    const ctx = await context();
    await expect(
      handler().handle(ctx, auth(), {
        buffer: xlsx.build([{ name: 'Import', data: [['Value'], ['C']] }]),
        columns: [{ dataIndex: name.split('.'), defaultTitle: 'Value' }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await rows()).toEqual([]);
  });

  it('rejects a file beyond creation capacity instead of partially importing it', async () => {
    const ctx = await context();
    await expect(
      handler().handle(ctx, auth(), file([['Name', 'Amount'], ...Array.from({ length: 1001 }, () => ['Too many', 1])])),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await rows()).toEqual([]);
  });

  it('rejects an empty data file without reporting a successful write', async () => {
    const ctx = await context();
    await expect(handler().handle(ctx, auth(), file([['Name', 'Amount']]))).rejects.toMatchObject({
      code: 'INVALID_ACCESS_MUTATION',
    });
    expect(await rows()).toEqual([]);
  });

  it('rejects missing active tenant context', async () => {
    const ctx = await context();
    await expect(handler().handle(ctx, { ...auth(), tenantId: undefined }, file())).rejects.toBeDefined();
    expect(await rows()).toEqual([]);
  });

  it('uses captured upload values rather than merged action parameters', async () => {
    const ctx = await context();
    ctx.action.mergeParams({ values: { name: 'Injected', tenantId: 'C' } });
    await handler().handle(ctx, auth(), file());
    expect((await rows()).map((row) => [row.name, row.tenantId])).toEqual([
      ['First', 'B'],
      ['Second', 'B'],
    ]);
  });

  it('preserves numeric zero and omitted cells use database defaults', async () => {
    const ctx = await context();
    await handler().handle(
      ctx,
      auth(),
      file([
        ['Name', 'Amount'],
        ['Zero', 0],
        ['Default', null],
      ]),
    );
    expect(await rows()).toMatchObject([
      { name: 'Zero', amount: 0 },
      { name: 'Default', amount: 10 },
    ]);
  });

  it('keeps shared configured scalar imports independent of tenant context', async () => {
    await store.save(
      mainIdentity,
      { ...configFor({ type: 'constant', value: true }), ownership: { enabled: false }, revision: 1 },
      { userId: 28 },
    );
    const ctx = await context();
    await handler().handle(ctx, { ...auth(), tenantId: undefined }, file());
    expect(await rows()).toMatchObject([
      { name: 'First', tenantId: null },
      { name: 'Second', tenantId: null },
    ]);
  });

  it.each(['field options', 'parser registration'])(
    'rejects %s changing during asynchronous conversion',
    async (change) => {
      const ctx = await context();
      const Parser = db.fieldValueParsers.get('string');
      db.registerFieldValueParsers({
        string: class extends Parser {
          async setValue(value: unknown) {
            await super.setValue(value);
            if (change === 'field options') docs.getField('name').options.interface = 'attachment';
            else db.registerFieldValueParsers({ string: Parser });
          }
        },
      });
      await expect(handler().handle(ctx, auth(), file())).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(await rows()).toEqual([]);
    },
  );

  it('keeps the uploaded bytes, mapping and actor detached across asynchronous conversion', async () => {
    const ctx = await context();
    const upload = file();
    const actor = auth();
    const Parser = db.fieldValueParsers.get('string');
    db.registerFieldValueParsers({
      string: class extends Parser {
        async setValue(value: unknown) {
          upload.buffer.fill(0);
          upload.columns[0].dataIndex[0] = 'tenantId';
          actor.tenantId = 'C';
          await super.setValue(value);
        }
      },
    });
    await handler().handle(ctx, actor, upload);
    expect(await rows()).toMatchObject([
      { name: 'First', tenantId: 'B' },
      { name: 'Second', tenantId: 'B' },
    ]);
  });

  it('does not trust uploaded enumeration values over the registered field options', async () => {
    docs.getField('name').options.uiSchema = { enum: [{ label: 'Approved', value: 'approved' }] };
    const ctx = await context();
    const upload = file([
      ['Name', 'Amount'],
      ['Forged label', 1],
    ]);
    Object.assign(upload.columns[0], { enum: [{ label: 'Forged label', value: 'approved' }] });
    await expect(handler().handle(ctx, auth(), upload)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await rows()).toEqual([]);
  });

  it('rolls back when an insert hook makes an imported scalar a protected foreign key', async () => {
    docs.model.addHook('afterCreate', 'change-import-protection', () => {
      docs.model.rawAttributes.amount.references = { model: 'tenants', key: 'id' };
    });
    const ctx = await context();
    await expect(handler().handle(ctx, auth(), file())).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await rows()).toEqual([]);
    expect(ctx.body).toBe('unchanged');
  });
});

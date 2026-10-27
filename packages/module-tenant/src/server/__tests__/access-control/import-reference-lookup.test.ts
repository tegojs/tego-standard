import { ACL, Resourcer, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { AccessCreationService } from '../../access-control/creation';
import * as lookup from '../../access-control/import-reference-lookup';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const projectIdentity = { ...mainIdentity, collectionName: 'projects', collectionKey: 'projects-key' };
const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])(
  'authorized import reference lookup (%s)',
  (dialect) => {
    let db: Database;
    let docs: Collection;
    let projects: Collection;
    let adapter: AccessAclScopeAdapter;
    let store: AccessConfigStore;
    const auth = () => ({ tenantId: 'B', roleName: 'importer', userId: 28 });
    const identity = (collection: Collection) => (collection === docs ? mainIdentity : projectIdentity);

    beforeEach(async () => {
      db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
      await seedConfigStore(db);
      await seedAclScopes(db);
      projects = db.collection({
        name: 'projects',
        timestamps: false,
        fields: [
          { name: 'id', type: 'bigInt', primaryKey: true },
          { name: 'name', type: 'string' },
          { name: 'tenantId', type: 'string' },
          { name: 'code', type: 'bigInt' },
          { name: 'cost', type: 'decimal' },
        ],
      });
      docs = db.collection({
        name: 'documents',
        timestamps: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true },
          { name: 'tenantId', type: 'string' },
          { name: 'name', type: 'string' },
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
      await tenants.model.bulkCreate(['H', 'B', 'C'].map((id) => ({ id, enabled: true })));
      await projects.model.sync();
      await docs.model.sync();
      await projects.model.bulkCreate([
        { id: 101, name: 'Owned', tenantId: 'B', code: 1 },
        { id: 102, name: 'Visible', tenantId: 'H', code: 2 },
        { id: 103, name: 'Hidden', tenantId: 'C', code: 3 },
        { id: 104, name: 'Legacy', tenantId: null, code: 4 },
      ]);
      await db.getRepository('collections').create({ values: { name: 'projects', key: 'projects-key' } });
      store = new AccessConfigStore(db, (key) =>
        resolveModelMetadata(db.getCollection(key.collectionName), {
          resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
        }),
      );
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
      await store.save(mainIdentity, { ...configFor(ownerCondition), revision: 0 }, { userId: 28 });
      await store.save(projectIdentity, { ...config, revision: 0 }, { userId: 28 });
      adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      try {
        if (dialect === 'postgres') await db?.sequelize.drop({ cascade: true });
      } finally {
        await db?.close();
      }
    });

    async function context(resource = 'documents', actionName = 'importXlsx', grant: object = {}, params: object = {}) {
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
        state: { currentRole: 'importer', currentUser: { id: 28, name: 'Owned' } },
        get: () => '+08:00',
        logger: { info: () => {} },
        throw: (status: number) => {
          throw new Error(String(status));
        },
        permission: undefined as unknown,
      };
      await adapter.prepare(ctx, [mainIdentity, projectIdentity]);
      await acl.middleware()(ctx as never, async () => {});
      return ctx;
    }
    async function prepare(
      options: {
        fields?: string[];
        targetGrant?: object;
        targetParams?: object;
        lookupField?: string;
        columns?: object[];
        authorize?: () => Promise<unknown>;
      } = {},
    ) {
      const ctx = await context('documents', 'importXlsx', { fields: options.fields ?? ['project'] });
      const service = new lookup.AccessImportReferenceLookup(
        db,
        adapter,
        new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection))),
        identity,
      );
      return service.prepare(
        ctx,
        mainIdentity,
        auth(),
        options.columns ?? [{ dataIndex: ['project', options.lookupField ?? 'name'], defaultTitle: 'Project' }],
        options.authorize ??
          (() =>
            context(
              'projects',
              'list',
              options.targetGrant ?? { fields: ['id', 'name', 'code'] },
              options.targetParams,
            )),
      );
    }
    const targets = async () => (await projects.model.findAll({ order: [['id', 'ASC']] })).map((row) => row.get());

    it('resolves owned, visibility-only and legacy targets without writing or claiming them', async () => {
      const before = await targets();
      const plan = await prepare();
      const result = await plan.resolve([['Owned'], ['Visible'], ['Legacy']]);
      expect(result.map((row) => row.map((ref) => [ref.association, ref.key, ref.target]))).toEqual([
        [['project', '101', projectIdentity]],
        [['project', '102', projectIdentity]],
        [['project', '104', projectIdentity]],
      ]);
      expect(await targets()).toEqual(before);
      expect(await docs.model.count()).toBe(0);
    });
    it.each(['Hidden', 'Missing'])('does not resolve an inaccessible or missing target %s', async (value) => {
      const plan = await prepare();
      await expect(plan.resolve([[value]])).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      expect(await docs.model.count()).toBe(0);
    });
    it('applies the target role condition independently of tenant visibility', async () => {
      const plan = await prepare({
        targetGrant: { fields: ['id', 'name'], filter: { name: '{{ ctx.state.currentUser.name }}' } },
      });
      await expect(plan.resolve([['Visible']])).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    });
    it('rejects multiple readable matches instead of selecting the first one', async () => {
      await projects.model.create({ id: 105, name: 'Owned', tenantId: 'B' });
      const plan = await prepare();
      await expect(plan.resolve([['Owned']])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    });
    it('ignores hidden namesakes when one permitted record matches', async () => {
      await projects.model.create({ id: 105, name: 'Owned', tenantId: 'C' });
      const plan = await prepare();
      expect((await plan.resolve([['Owned']]))[0][0].key).toBe('101');
    });
    it.each([['name'], ['id']])('requires target key and lookup-field read grants %j', async (fields) => {
      const plan = await prepare({ targetGrant: { fields } });
      await expect(plan.resolve([['Owned']])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    });
    it('rejects missing target operation permission', async () => {
      const plan = await prepare({ authorize: async () => null });
      await expect(plan.resolve([['Owned']])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    });
    it('rejects a source field outside the import grant before a target decision', async () => {
      let called = false;
      await expect(
        prepare({
          fields: ['name'],
          authorize: async () => {
            called = true;
            return null;
          },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(called).toBe(false);
    });
    it.each(['project.missing', 'project.owner.name', 'name.id'])('rejects unsupported mapping %s', async (path) => {
      await expect(
        prepare({ columns: [{ dataIndex: path.split('.'), defaultTitle: 'Project' }] }),
      ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    });
    it('rejects a repeated relation even when lookup fields differ', async () => {
      await expect(
        prepare({
          columns: [
            { dataIndex: ['project', 'name'], defaultTitle: 'Name' },
            { dataIndex: ['project', 'id'], defaultTitle: 'ID' },
          ],
        }),
      ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    });
    it('rejects a prefiltered target context instead of borrowing its request values', async () => {
      const plan = await prepare({ targetParams: { filter: { id: 101 } } });
      await expect(plan.resolve([['Owned']])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    });
    it('uses the registered scalar parser for a non-key numeric lookup', async () => {
      await projects.model.update({ code: 1000 }, { where: { id: 101 } });
      const plan = await prepare({ lookupField: 'code' });
      expect((await plan.resolve([['1,000']]))[0][0].key).toBe('101');
    });
    it('resolves a primary-key lookup without requiring the name field', async () => {
      const plan = await prepare({ lookupField: 'id', targetGrant: { fields: ['id'] } });
      expect((await plan.resolve([['00101']]))[0][0].key).toBe('101');
    });
    it('preserves blank associations as null selections', async () => {
      const plan = await prepare();
      expect((await plan.resolve([[null], ['  ']])).map((row) => row[0].key)).toEqual([null, null]);
      expect(await docs.model.count()).toBe(0);
    });
    it('captures row values before waiting for independent target authorization', async () => {
      const values = [['Owned']];
      const plan = await prepare({
        authorize: async () => {
          values[0][0] = 'Hidden';
          return context('projects', 'list', { fields: ['id', 'name'] });
        },
      });
      expect((await plan.resolve(values))[0][0].key).toBe('101');
    });
    it('rejects relation metadata changes during target authorization', async () => {
      const plan = await prepare({
        authorize: async () => {
          (docs.model.associations.project as unknown as { scope: object }).scope = { id: 103 };
          return context('projects', 'list', { fields: ['id', 'name'] });
        },
      });
      await expect(plan.resolve([['Owned']])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    });

    it('applies the registered association scope to the selected target', async () => {
      (docs.model.associations.project as unknown as { scope: object }).scope = { code: 2 };
      const plan = await prepare();
      await expect(plan.resolve([['Owned']])).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      expect((await (await prepare()).resolve([['Visible']]))[0][0].key).toBe('102');
    });

    it('preserves a numeric zero lookup value', async () => {
      await projects.model.update({ code: 0 }, { where: { id: 101 } });
      const plan = await prepare({ lookupField: 'code' });
      expect((await plan.resolve([[0]]))[0][0].key).toBe('101');
    });

    it('does not interpret a nonempty numeric null marker as an empty reference', async () => {
      const plan = await prepare({ lookupField: 'code' });
      await expect(plan.resolve([['n/a']])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    });

    it('reads target records inside the supplied caller transaction without committing it', async () => {
      const plan = await prepare();
      const rollback = new Error('Caller rolls back the import');
      await expect(
        db.sequelize.transaction(async (transaction) => {
          await projects.model.create({ id: 105, name: 'Uncommitted', tenantId: 'B' }, { transaction });
          expect((await plan.resolve([['Uncommitted']], transaction))[0][0].key).toBe('105');
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect(await projects.model.findByPk(105)).toBeNull();
      expect(await docs.model.count()).toBe(0);
    });

    it('does not reuse a lookup plan for another authorization operation', async () => {
      const plan = await prepare();
      await plan.resolve([['Owned']]);
      await expect(plan.resolve([['Visible']])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    });

    it('authorizes every target before parsing any cell', async () => {
      docs.setField('secondaryProject', { type: 'belongsTo', target: 'projects', foreignKey: 'secondaryProjectId' });
      await docs.model.sync({ alter: true });
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
      let decisions = 0;
      const plan = await prepare({
        fields: ['project', 'secondaryProject'],
        columns: [
          { dataIndex: ['project', 'name'], defaultTitle: 'First project' },
          { dataIndex: ['secondaryProject', 'name'], defaultTitle: 'Second project' },
        ],
        authorize: async () => (++decisions === 1 ? context('projects', 'list', { fields: ['id', 'name'] }) : null),
      });
      await expect(plan.resolve([['Owned', 'Visible']])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(parsed).toBe(false);
    });

    it.runIf(dialect === 'postgres')('preserves bigint primary key precision during lookup', async () => {
      await projects.model.create({ id: '9007199254740993', name: 'Large key', tenantId: 'B' });
      const plan = await prepare({ lookupField: 'id', targetGrant: { fields: ['id'] } });
      expect((await plan.resolve([['9007199254740993']]))[0][0].key).toBe('9007199254740993');
    });

    it.runIf(dialect === 'postgres')(
      'rejects a lossy returned key in a name lookup instead of choosing the rounded ID',
      async () => {
        await projects.model.create({ id: '9007199254740993', name: 'Large key', tenantId: 'B' });
        const plan = await prepare();
        await expect(plan.resolve([['Large key']])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
        expect(await projects.model.count({ where: { id: '9007199254740993' } })).toBe(1);
      },
    );

    it.runIf(dialect === 'postgres')(
      'rejects unsafe non-key integer conversion instead of resolving the neighboring code',
      async () => {
        await projects.model.update({ code: '9007199254740992' }, { where: { id: 101 } });
        await projects.model.update({ code: '9007199254740993' }, { where: { id: 102 } });
        const plan = await prepare({ lookupField: 'code' });
        await expect(plan.resolve([['9007199254740993']])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      },
    );

    it.runIf(dialect === 'postgres')(
      'rejects an exact decimal lookup that the ordinary numeric parser would round',
      async () => {
        await projects.model.update({ cost: '0.1' }, { where: { id: 101 } });
        await projects.model.update({ cost: '0.100000000000000001' }, { where: { id: 102 } });
        const attempt = async () => {
          const plan = await prepare({ lookupField: 'cost', targetGrant: { fields: ['id', 'cost'] } });
          return plan.resolve([['0.100000000000000001']]);
        };
        await expect(attempt()).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      },
    );

    it('keeps reference lookup separate from multi-relation foreign-key write protection', async () => {
      docs.setField('sameProject', { type: 'belongsTo', target: 'projects', foreignKey: 'projectId' });
      const plan = await prepare();
      const references = (await plan.resolve([['Owned']]))[0];
      expect(references[0].key).toBe('101');
      const ctx = await context();
      const queries = new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection)));
      await expect(
        new AccessCreationService(db, adapter, queries).withCreatedRecords(
          ctx,
          mainIdentity,
          auth(),
          { values: [{ id: 1, name: 'Must not write' }], references },
          async (write) => [await docs.repository.create({ values: write.values[0], transaction: write.transaction })],
        ),
      ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(await docs.model.count()).toBe(0);
    });
  },
);

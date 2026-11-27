import { createMockServer, type MockServer } from '@tachybase/test';
import { ACL, Repository, Transaction } from '@tego/server';

import { EXECUTION_STATUS } from '../../../../../module-workflow/src/server/constants';
import type WorkflowPlugin from '../../../../../module-workflow/src/server/Plugin';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessConfigHistory } from '../../access-control/config-history';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { AccessWorkflowRootHandler } from '../../access-control/workflow-root-handler';
import { AccessWorkflowWriteTransactionPlanner } from '../../access-control/workflow-write-transaction';
import { isolatedPostgresDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const supportsDeferredAssociationEvents =
  typeof (Repository.prototype as unknown as Record<string, unknown>).withDeferredAssociationEvents === 'function';

describe.runIf(!!postgresUrl)('configured workflow relationship selection writes', () => {
  let app: MockServer;
  let plugin: WorkflowPlugin;
  let adapter: AccessAclScopeAdapter;
  let store: AccessConfigStore;
  let handler: AccessWorkflowRootHandler;
  let planner: AccessWorkflowWriteTransactionPlanner;
  let documents;
  let projects;
  let links;
  let labelLinks;
  let children;
  let profiles;
  let workflow;
  let isolation: string;
  let executionError: Error | undefined;
  let failLater: boolean;
  let interfere: ((record, options) => Promise<void>) | undefined;
  const identities = new Map();
  const identity = (collection) => identities.get(collection);
  const key = (collection) => accessCollectionKey(identity(collection));

  beforeAll(async () => {
    const checked = isolatedPostgresDatabase(postgresUrl!);
    const database = checked.options;
    await checked.close();
    const execute = (action: 'update' | 'destroy') => () => async (request) => {
      const [rows] = await app.db.sequelize.query("SELECT current_setting('transaction_isolation') AS isolation", {
        transaction: request.transaction,
      });
      isolation = rows[0].isolation;
      try {
        return await (action === 'update' ? handler.update(request) : handler.destroy(request));
      } catch (error) {
        executionError = error as Error;
        throw error;
      }
    };
    app = await createMockServer({
      database,
      plugins: [
        'error-handler',
        'collection',
        'user',
        [
          'workflow',
          {
            updateTransactionPlanner: async (target) => {
              try {
                return await planner.plan(target);
              } catch (error) {
                executionError = error as Error;
                throw error;
              }
            },
            destroyTransactionPlanner: async (target) => {
              try {
                return await planner.plan(target);
              } catch (error) {
                executionError = error as Error;
                throw error;
              }
            },
            updateResolver: execute('update'),
            destroyResolver: execute('destroy'),
          },
        ],
      ],
    });
    plugin = app.pm.get('workflow') as WorkflowPlugin;
    const add = async (name, fields) => {
      const row = await app.db.getRepository('collections').create({ context: {}, values: { name, fields } });
      const collection = app.db.getCollection(name);
      identities.set(collection, { dataSourceKey: 'main', collectionKey: row.get('key'), collectionName: name });
      await collection.model.sync();
      return collection;
    };
    projects = await add('selectionProjects', [
      { name: 'name', type: 'string' },
      { name: 'tenantId', type: 'string' },
    ]);
    documents = await add('selectionDocuments', [
      { name: 'name', type: 'string' },
      { name: 'tenantId', type: 'string' },
      { name: 'project', type: 'belongsTo', target: projects.name, foreignKey: 'projectId', onDelete: 'RESTRICT' },
      {
        name: 'alternative',
        type: 'belongsTo',
        target: projects.name,
        foreignKey: 'alternativeId',
        onDelete: 'RESTRICT',
      },
    ]);
    links = await add('selectionLinks', []);
    documents.setField('tags', {
      type: 'belongsToMany',
      target: projects.name,
      through: links.name,
      foreignKey: 'documentId',
      otherKey: 'projectId',
      onDelete: 'RESTRICT',
    });
    await links.model.sync({ alter: true });
    labelLinks = await add('selectionLabelLinks', []);
    documents.setField('labels', {
      type: 'belongsToMany',
      target: projects.name,
      through: labelLinks.name,
      foreignKey: 'documentId',
      otherKey: 'projectId',
      onDelete: 'RESTRICT',
    });
    await labelLinks.model.sync({ alter: true });
    children = await add('selectionChildren', [
      { name: 'name', type: 'string' },
      { name: 'tenantId', type: 'string' },
      { name: 'document', type: 'belongsTo', target: documents.name, foreignKey: 'documentId', onDelete: 'RESTRICT' },
    ]);
    documents.setField('children', {
      type: 'hasMany',
      target: children.name,
      foreignKey: 'documentId',
      onDelete: 'RESTRICT',
    });
    profiles = await add('selectionProfiles', [
      { name: 'name', type: 'string' },
      { name: 'tenantId', type: 'string' },
      { name: 'document', type: 'belongsTo', target: documents.name, foreignKey: 'documentId', onDelete: 'RESTRICT' },
    ]);
    documents.setField('profile', {
      type: 'hasOne',
      target: profiles.name,
      foreignKey: 'documentId',
      onDelete: 'RESTRICT',
    });
    const tenants = app.db.collection({
      name: 'tenants',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'enabled', type: 'boolean' },
      ],
    });
    await tenants.model.sync();
    await tenants.model.bulkCreate(['B', 'C', 'H'].map((id) => ({ id, enabled: true })));
    await app.db.collection(accessConfigHistory).model.sync();
    store = new AccessConfigStore(app.db, (source) =>
      resolveModelMetadata(app.db.getCollection(source.collectionName), { resolveCollectionKey: key }),
    );
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, app.db);
    planner = new AccessWorkflowWriteTransactionPlanner(app.db, store, identity);
    handler = new AccessWorkflowRootHandler(
      app.db,
      adapter,
      new AccessQueryService(app.db, adapter, key),
      identity,
      (request) => plugin.captureDataOperationAuthority(request),
    );
    const after = async (record, options) => {
      if (failLater && record.getDataValue('id') === 3) throw new Error('later selection write failed');
      await interfere?.(record, options);
    };
    app.db.on(`${documents.name}.afterUpdate`, after);
    app.db.on(`${documents.name}.afterDestroy`, after);
  });

  async function save(collection, config) {
    const source = identity(collection);
    const previous = await store.read(source);
    await store.save(source, { ...config, revision: previous?.revision ?? 0 }, { userId: 28 });
  }

  beforeEach(async () => {
    isolation = '';
    executionError = undefined;
    failLater = false;
    interfere = undefined;
    const sourceConfig = configFor(ownerCondition);
    sourceConfig.rules.push({
      ...configFor({ type: 'constant', value: true }, 'visibility').rules[0],
      id: 'source-visible',
    });
    await save(documents, sourceConfig);
    const targetConfig = configFor(ownerCondition);
    targetConfig.rules.push({
      ...configFor(
        {
          type: 'compare',
          operator: 'eq',
          left: { type: 'field', path: 'name' },
          right: { type: 'literal', value: 'Visible' },
        },
        'visibility',
      ).rules[0],
      id: 'target-visible',
    });
    await save(projects, targetConfig);
    await save(links, { ...configFor({ type: 'constant', value: true }), ownership: { enabled: false } });
    await save(children, targetConfig);
    await save(profiles, targetConfig);
    await profiles.model.destroy({ where: {}, hooks: false });
    await children.model.destroy({ where: {}, hooks: false });
    await labelLinks.model.destroy({ where: {}, hooks: false });
    await links.model.destroy({ where: {}, hooks: false });
    await documents.model.destroy({ where: {}, hooks: false });
    await projects.model.destroy({ where: {}, hooks: false });
    await projects.model.bulkCreate([
      { id: 101, name: 'Visible', tenantId: 'H' },
      { id: 102, name: 'Hidden', tenantId: 'C' },
      { id: 103, name: 'Owned', tenantId: 'B' },
    ]);
    await documents.model.bulkCreate([
      { id: 1, name: 'First', tenantId: 'B', projectId: 101 },
      { id: 2, name: 'Hidden target', tenantId: 'B', projectId: 102 },
      { id: 3, name: 'Second', tenantId: 'B', projectId: 103 },
      { id: 4, name: 'Other tenant', tenantId: 'C', projectId: 101 },
      { id: 5, name: 'Legacy', tenantId: null, projectId: 101 },
    ]);
    workflow = await app.db.getRepository('workflows').create({
      values: {
        title: 'Selection write test',
        type: 'collection',
        enabled: true,
        sync: true,
        config: { collection: 'selectionEvents', mode: 1 },
      },
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await workflow?.update({ enabled: false });
  });
  afterAll(async () => {
    if (!app) return;
    const tables = Object.values(app.db.sequelize.models).map((model) => model.getTableName());
    await app.destroy();
    const cleanup = isolatedPostgresDatabase(postgresUrl!);
    try {
      for (const table of tables) await cleanup.sequelize.getQueryInterface().dropTable(table, { cascade: true });
    } finally {
      await cleanup.close();
    }
  });

  async function run(action: 'update' | 'destroy', params: object, inherited?: 'serializable' | 'ordinary') {
    await workflow.createNode({ type: action, config: { collection: documents.name, params } });
    const transaction =
      inherited &&
      (await app.db.sequelize.transaction({
        isolationLevel:
          inherited === 'serializable'
            ? Transaction.ISOLATION_LEVELS.SERIALIZABLE
            : Transaction.ISOLATION_LEVELS.READ_COMMITTED,
      }));
    try {
      await plugin.trigger(
        workflow,
        {},
        { transaction: transaction || undefined, context: { state: { currentTenantId: 'B' } } },
      );
      const [execution] = await workflow.getExecutions({
        transaction: transaction || undefined,
        order: [['id', 'DESC']],
      });
      const [job] = await execution.getJobs({ transaction: transaction || undefined });
      const result = { status: execution.status, result: job.result };
      if (transaction) {
        if (result.status === EXECUTION_STATUS.RESOLVED) await transaction.commit();
        else await transaction.rollback();
      }
      return result;
    } catch (error) {
      if (transaction && !(transaction as Transaction & { finished?: string }).finished) await transaction.rollback();
      throw error;
    }
  }
  const get = async (id: number) => (await documents.model.findByPk(id))?.get({ plain: true });
  const params = (action, filter, extra = {}) => ({
    filter,
    ...extra,
    ...(action === 'update' ? { values: { name: 'Selected' } } : {}),
  });

  it('filters a scalar update through many-to-many readable targets and a shared join without tenantId', async () => {
    await links.model.bulkCreate([
      { documentId: 1, projectId: 101 },
      { documentId: 1, projectId: 103 },
      { documentId: 2, projectId: 102 },
      { documentId: 4, projectId: 101 },
    ]);
    expect(links.model.rawAttributes.tenantId).toBeUndefined();
    const job = await run('update', params('update', { tags: { name: { $in: ['Visible', 'Owned'] } } }));
    expect(job.status, executionError?.stack).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result).toMatchObject({ length: 1, data: [{ id: 1, name: 'Selected' }] });
    expect(await get(2)).toMatchObject({ name: 'Hidden target' });
    expect(await get(4)).toMatchObject({ name: 'Other tenant' });
    expect(await links.model.count()).toBe(4);
  });

  it('requires readable through rows as well as readable many-to-many targets', async () => {
    await links.model.create({ documentId: 1, projectId: 101 });
    await save(links, { ...configFor({ type: 'constant', value: false }), ownership: { enabled: false } });
    const job = await run('update', params('update', { tags: { name: 'Visible' } }));
    expect(job.status, executionError?.stack).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result.length).toBe(0);
    expect(await get(1)).toMatchObject({ name: 'First' });
    expect(await links.model.count()).toBe(1);
  });

  it('filters through readable children without duplicating or changing them', async () => {
    await children.model.bulkCreate([
      { id: 201, name: 'Owned', tenantId: 'B', documentId: 1 },
      { id: 202, name: 'Visible', tenantId: 'H', documentId: 1 },
      { id: 203, name: 'Hidden', tenantId: 'C', documentId: 2 },
      { id: 204, name: 'Visible', tenantId: 'H', documentId: 4 },
    ]);
    const job = await run('update', params('update', { children: { name: { $in: ['Visible', 'Owned'] } } }));
    expect(job.status, executionError?.stack).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result).toMatchObject({ length: 1, data: [{ id: 1, name: 'Selected' }] });
    expect(await get(2)).toMatchObject({ name: 'Hidden target' });
    expect(await get(4)).toMatchObject({ name: 'Other tenant' });
    expect(await children.model.count()).toBe(4);
    expect((await children.model.findByPk(202)).get('tenantId')).toBe('H');
  });

  it('does not combine fields from two different children into one match', async () => {
    await children.model.bulkCreate([
      { id: 201, name: 'Owned', tenantId: 'B', documentId: 1 },
      { id: 202, name: 'Visible', tenantId: 'H', documentId: 1 },
    ]);
    const job = await run('update', params('update', { children: { name: 'Visible', tenantId: 'B' } }));
    expect(job.status, executionError?.stack).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result.length).toBe(0);
    expect(await get(1)).toMatchObject({ name: 'First' });
  });

  it('claims editable legacy sources without claiming the related visible record', async () => {
    const config = configFor(ownerCondition);
    config.rules.push({
      ...configFor({ type: 'isNull', operand: { type: 'field', path: 'tenantId' } }).rules[0],
      id: 'legacy-edit',
    });
    await save(documents, config);
    const job = await run('update', params('update', { project: { name: 'Visible' } }, { filterByTk: 5 }));
    expect(job.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(await get(5)).toMatchObject({ name: 'Selected', tenantId: 'B' });
    expect((await projects.model.findByPk(101)).get('tenantId')).toBe('H');
  });

  it('does not require the source to still match ordinary selection conditions after its authorized update', async () => {
    const job = await run('update', params('update', { name: 'First', project: { name: 'Visible' } }));
    expect(job.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result.length).toBe(1);
    expect(await get(1)).toMatchObject({ name: 'Selected' });
    expect(job.result.data[0].project).toBeUndefined();
  });

  it('rejects link selection writes before any source write when core lifecycle capability is missing', async () => {
    const repository = documents.repository;
    const previous = Object.getOwnPropertyDescriptor(repository, 'withDeferredAssociationEvents');
    Object.defineProperty(repository, 'withDeferredAssociationEvents', { value: undefined, configurable: true });
    let writes = 0;
    const listener = () => {
      writes++;
    };
    app.db.on(`${documents.name}.beforeUpdate`, listener);
    try {
      const job = await run('update', {
        filter: { project: { name: 'Visible' } },
        values: { labels: [103], name: 'No' },
      });
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(job.result.message).toMatch(/core deferred association events/i);
      expect(writes).toBe(0);
      expect(await get(1)).toMatchObject({ name: 'First' });
      expect(await labelLinks.model.count()).toBe(0);
    } finally {
      app.db.off(`${documents.name}.beforeUpdate`, listener);
      if (previous) Object.defineProperty(repository, 'withDeferredAssociationEvents', previous);
      else delete repository.withDeferredAssociationEvents;
    }
  });

  describe.runIf(supportsDeferredAssociationEvents)('pure-link writes with relationship selection', () => {
    const linked = async (documentId = 1, transaction?) =>
      (await labelLinks.model.findAll({ where: { documentId }, order: [['projectId', 'ASC']], transaction })).map(
        (row) => row.getDataValue('projectId'),
      );

    it.each([undefined, 'serializable'] as const)(
      'replaces links selected through a readable project in a %s transaction',
      async (inherited) => {
        await labelLinks.model.create({ documentId: 1, projectId: 101 });
        const job = await run(
          'update',
          { filter: { project: { name: 'Visible' } }, values: { labels: [103], name: 'Linked' } },
          inherited,
        );
        expect(job.status, executionError?.stack).toBe(EXECUTION_STATUS.RESOLVED);
        expect(isolation).toBe('serializable');
        expect(job.result).toMatchObject({ length: 1, data: [{ id: 1, name: 'Linked', tenantId: 'B' }] });
        expect(await linked()).toEqual([103]);
        expect(await get(4)).toMatchObject({ name: 'Other tenant', tenantId: 'C' });
        expect((await projects.model.findByPk(101)).get('tenantId')).toBe('H');
      },
    );

    it('clears links without reading an old hidden target', async () => {
      await labelLinks.model.create({ documentId: 1, projectId: 102 });
      const job = await run('update', { filter: { project: { name: 'Visible' } }, values: { labels: [] } });
      expect(job.status, executionError?.stack).toBe(EXECUTION_STATUS.RESOLVED);
      expect(job.result.length).toBe(1);
      expect(await linked()).toEqual([]);
      expect((await projects.model.findByPk(102)).get('tenantId')).toBe('C');
    });

    it('changes a link set and a single reference without requiring the old project filter afterward', async () => {
      const job = await run('update', {
        filter: { project: { name: 'Visible' } },
        values: { labels: [101], project: 103, name: 'Both' },
      });
      expect(job.status, executionError?.stack).toBe(EXECUTION_STATUS.RESOLVED);
      expect(job.result).toMatchObject({ length: 1, data: [{ id: 1, name: 'Both', projectId: 103 }] });
      expect(await linked()).toEqual([101]);
    });

    it('rejects a hidden new target without persisting links or scalar values', async () => {
      const job = await run('update', {
        filter: { project: { name: 'Visible' } },
        values: { labels: [102], name: 'No' },
      });
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(executionError).toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      expect(await get(1)).toMatchObject({ name: 'First' });
      expect(await linked()).toEqual([]);
    });

    it.each([3, 4])('requires both G and the old filter for explicit source %s', async (id) => {
      const job = await run('update', {
        filterByTk: id,
        filter: { project: { name: 'Visible' } },
        values: { labels: [103] },
      });
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(executionError).toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      expect(await labelLinks.model.count()).toBe(0);
      expect(await get(id)).toMatchObject({ name: id === 3 ? 'Second' : 'Other tenant' });
    });

    it('does not select a hidden related row because the new link target is readable', async () => {
      const job = await run('update', { filter: { project: { name: 'Hidden' } }, values: { labels: [103] } });
      expect(job.status, executionError?.stack).toBe(EXECUTION_STATUS.RESOLVED);
      expect(job.result).toEqual({ length: 0, data: [] });
      expect(await labelLinks.model.count()).toBe(0);
    });

    it.each([true, false])('respects independently configured filter-through readability: %s', async (readable) => {
      await links.model.create({ documentId: 1, projectId: 101 });
      await save(links, { ...configFor({ type: 'constant', value: readable }), ownership: { enabled: false } });
      const job = await run('update', { filter: { tags: { name: 'Visible' } }, values: { labels: [103] } });
      expect(job.status, executionError?.stack).toBe(EXECUTION_STATUS.RESOLVED);
      expect(job.result.length).toBe(readable ? 1 : 0);
      expect(await linked()).toEqual(readable ? [103] : []);
      expect(await links.model.count()).toBe(1);
    });

    it('keeps an unchanged hidden link without writing or treating it as a new selection', async () => {
      await labelLinks.model.create({ documentId: 1, projectId: 102 });
      const before = await get(1);
      const job = await run('update', { filter: { project: { name: 'Visible' } }, values: { labels: [102] } });
      expect(job.status, executionError?.stack).toBe(EXECUTION_STATUS.RESOLVED);
      expect(job.result).toEqual({ length: 0, data: [] });
      expect(await get(1)).toEqual(before);
      expect(await linked()).toEqual([102]);
    });

    it.each([false, true])('claims an editable legacy source only when its links change: %s', async (change) => {
      const config = configFor(ownerCondition);
      config.rules.push({
        ...configFor({ type: 'isNull', operand: { type: 'field', path: 'tenantId' } }).rules[0],
        id: 'legacy-edit',
      });
      await save(documents, config);
      const before = await get(5);
      const job = await run('update', {
        filterByTk: 5,
        filter: { project: { name: 'Visible' } },
        values: { labels: change ? [103] : [] },
      });
      expect(job.status, executionError?.stack).toBe(EXECUTION_STATUS.RESOLVED);
      expect(job.result.length).toBe(change ? 1 : 0);
      if (change) expect(await get(5)).toMatchObject({ tenantId: 'B' });
      else expect(await get(5)).toEqual(before);
      expect(await linked(5)).toEqual(change ? [103] : []);
    });

    it('keeps the original owner when a G rule authorizes a different tenant', async () => {
      await save(
        documents,
        configFor({
          type: 'compare',
          operator: 'eq',
          left: { type: 'field', path: 'tenantId' },
          right: { type: 'literal', value: 'C' },
        }),
      );
      const job = await run('update', {
        filterByTk: 4,
        filter: { project: { name: 'Visible' } },
        values: { labels: [103] },
      });
      expect(job.status, executionError?.stack).toBe(EXECUTION_STATUS.RESOLVED);
      expect(await get(4)).toMatchObject({ tenantId: 'C' });
      expect(await linked(4)).toEqual([103]);
    });

    it('rejects an explicit batch containing a V-only source before writing any link', async () => {
      const job = await run('update', {
        filterByTk: [1, 4],
        filter: { project: { name: 'Visible' } },
        values: { labels: [103], name: 'No' },
      });
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(executionError).toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      expect(await labelLinks.model.count()).toBe(0);
      expect(await get(1)).toMatchObject({ name: 'First' });
    });

    it('rolls back earlier source and link writes after a later source fails', async () => {
      failLater = true;
      let notifications = 0;
      interfere = async (_record, options) => {
        options.transaction.afterCommit(() => {
          notifications++;
        });
      };
      const job = await run('update', {
        filter: { project: { name: { $in: ['Visible', 'Owned'] } } },
        values: { labels: [103], name: 'No' },
      });
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(executionError?.message).toContain('later selection write failed');
      expect(await labelLinks.model.count()).toBe(0);
      expect(await get(1)).toMatchObject({ name: 'First' });
      expect(await get(3)).toMatchObject({ name: 'Second' });
      expect(notifications).toBe(0);
    });

    it('publishes the complete source event after both links and references persist', async () => {
      const observed: Array<{ keys: number[]; projectId: number }> = [];
      const event = `${documents.name}.afterUpdateWithAssociations`;
      const listener = async (record, options) => {
        const persisted = await documents.model.findByPk(record.getDataValue('id'), {
          transaction: options.transaction,
        });
        observed.push({ keys: await linked(1, options.transaction), projectId: persisted.getDataValue('projectId') });
      };
      app.db.on(event, listener);
      let job;
      try {
        job = await run('update', {
          filter: { project: { name: 'Visible' } },
          values: { labels: [103], project: 103 },
        });
      } finally {
        app.db.off(event, listener);
      }
      expect(job.status, executionError?.stack).toBe(EXECUTION_STATUS.RESOLVED);
      expect(observed).toEqual([{ keys: [103], projectId: 103 }]);
    });

    it('rolls back links and a reference when the complete source event fails', async () => {
      const event = `${documents.name}.afterUpdateWithAssociations`;
      const listener = () => {
        throw new Error('selected link hook failed');
      };
      app.db.on(event, listener);
      let job;
      try {
        job = await run('update', {
          filter: { project: { name: 'Visible' } },
          values: { labels: [103], project: 103 },
        });
      } finally {
        app.db.off(event, listener);
      }
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(executionError?.message).toContain('selected link hook failed');
      expect(await get(1)).toMatchObject({ projectId: 101 });
      expect(await linked()).toEqual([]);
    });

    it('does not read an unconfigured through table even when it is a pure join', async () => {
      await labelLinks.model.create({ documentId: 1, projectId: 101 });
      const job = await run('update', { filter: { labels: { name: 'Visible' } }, values: { labels: [103] } });
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(job.result.message).toMatch(/configured related tables/i);
      expect(await linked()).toEqual([101]);
    });

    it('does not write an independently configured through table through the pure-link adapter', async () => {
      await save(links, {
        ...configFor({
          type: 'compare',
          operator: 'eq',
          left: { type: 'field', path: 'documentId' },
          right: { type: 'literal', value: 1 },
        }),
        ownership: { enabled: false },
      });
      await links.model.create({ documentId: 1, projectId: 101 });
      const job = await run('update', {
        filter: { project: { name: 'Visible' } },
        values: { tags: [103], name: 'No' },
      });
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(job.result.message).toMatch(/Independently controlled join records/i);
      expect(await links.model.count({ where: { documentId: 1, projectId: 101 } })).toBe(1);
      expect(await get(1)).toMatchObject({ name: 'First' });
    });

    it('does not upgrade or replace an inadequate inherited transaction', async () => {
      const job = await run(
        'update',
        { filter: { project: { name: 'Visible' } }, values: { labels: [103] } },
        'ordinary',
      );
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(job.result.message).toMatch(/sufficient isolation/i);
      expect(await linked()).toEqual([]);
    });
  });

  describe.each(['children', 'profile'] as const)('selection child lifecycle capability: %s', (name) => {
    it.each(['source', 'target'])('rejects missing %s capability before writing', async (side) => {
      const target = name === 'children' ? children : profiles;
      const repository = (side === 'source' ? documents : target).repository;
      const previous = Object.getOwnPropertyDescriptor(repository, 'withDeferredAssociationEvents');
      Object.defineProperty(repository, 'withDeferredAssociationEvents', { value: undefined, configurable: true });
      let writes = 0;
      const listener = () => {
        writes++;
      };
      app.db.on(`${documents.name}.beforeUpdate`, listener);
      try {
        const job = await run('update', {
          filterByTk: 1,
          filter: { project: { name: 'Visible' } },
          values: { [name]: name === 'children' ? [] : null, name: 'No' },
        });
        expect(job.status).toBe(EXECUTION_STATUS.ERROR);
        expect(job.result.message).toMatch(/core deferred association events/i);
        expect(writes).toBe(0);
        expect(await get(1)).toMatchObject({ name: 'First' });
      } finally {
        app.db.off(`${documents.name}.beforeUpdate`, listener);
        if (previous) Object.defineProperty(repository, 'withDeferredAssociationEvents', previous);
        else delete repository.withDeferredAssociationEvents;
      }
    });
  });

  describe.runIf(supportsDeferredAssociationEvents)('child writes with relationship selection', () => {
    describe.each(['children', 'profile'] as const)('%s replacement', (name) => {
      const target = () => (name === 'children' ? children : profiles);
      const value = (keys: number[]) => (name === 'children' ? keys : (keys[0] ?? null));
      const child = async (id: number) => (await target().model.findByPk(id)).get({ plain: true });
      const connected = async (transaction?) =>
        (await target().model.findAll({ where: { documentId: 1 }, order: [['id', 'ASC']], transaction })).map((row) =>
          row.getDataValue('id'),
        );
      beforeEach(async () => {
        await target().model.bulkCreate([
          { id: 201, name: 'Owned', tenantId: 'B', documentId: 1 },
          { id: 202, name: 'Replacement', tenantId: 'B', documentId: null },
          { id: 203, name: 'Visible', tenantId: 'H', documentId: null },
          { id: 204, name: 'Hidden', tenantId: 'C', documentId: null },
        ]);
      });

      it.each([undefined, 'serializable'] as const)(
        'replaces children selected through a readable project in a %s transaction',
        async (inherited) => {
          const job = await run(
            'update',
            {
              filterByTk: 1,
              filter: { project: { name: 'Visible' } },
              values: { [name]: value([202]), name: 'Replaced' },
            },
            inherited,
          );
          expect(job.status, executionError?.stack).toBe(EXECUTION_STATUS.RESOLVED);
          expect(isolation).toBe('serializable');
          expect(job.result).toMatchObject({ length: 1, data: [{ id: 1, name: 'Replaced', tenantId: 'B' }] });
          expect(await child(201)).toMatchObject({ documentId: null, tenantId: 'B' });
          expect(await child(202)).toMatchObject({ documentId: 1, tenantId: 'B' });
          expect((await projects.model.findByPk(101)).get('tenantId')).toBe('H');
        },
      );

      it('clears children selected through that relationship without requiring the old filter afterward', async () => {
        const job = await run('update', { filter: { [name]: { name: 'Owned' } }, values: { [name]: value([]) } });
        expect(job.status, executionError?.stack).toBe(EXECUTION_STATUS.RESOLVED);
        expect(job.result).toMatchObject({ length: 1, data: [{ id: 1 }] });
        expect(await child(201)).toMatchObject({ documentId: null, tenantId: 'B' });
        expect(await get(1)).toMatchObject({ name: 'First', tenantId: 'B' });
      });

      it.each(['addition', 'removal'])('rejects a visibility-only child %s', async (operation) => {
        if (operation === 'removal')
          await target().model.update({ tenantId: 'H', name: 'Visible' }, { where: { id: 201 }, hooks: false });
        const job = await run('update', {
          filter: { project: { name: 'Visible' } },
          values: { [name]: value([operation === 'addition' ? 203 : 202]), name: 'No' },
        });
        expect(job.status).toBe(EXECUTION_STATUS.ERROR);
        expect(executionError).toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
        expect(await connected()).toEqual([201]);
        expect(await child(202)).toMatchObject({ documentId: null });
        expect(await child(203)).toMatchObject({ documentId: null, tenantId: 'H' });
        expect(await get(1)).toMatchObject({ name: 'First' });
      });

      it('rejects an explicit source outside G even if its project is visible', async () => {
        const job = await run('update', {
          filterByTk: 4,
          filter: { project: { name: 'Visible' } },
          values: { [name]: value([202]) },
        });
        expect(job.status).toBe(EXECUTION_STATUS.ERROR);
        expect(executionError).toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
        expect(await child(202)).toMatchObject({ documentId: null });
      });

      it('rejects a writable explicit source that does not match the original relationship filter', async () => {
        const job = await run('update', {
          filterByTk: 3,
          filter: { project: { name: 'Visible' } },
          values: { [name]: value([202]) },
        });
        expect(job.status).toBe(EXECUTION_STATUS.ERROR);
        expect(executionError).toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
        expect(await get(3)).toMatchObject({ name: 'Second' });
        expect(await connected()).toEqual([201]);
        expect(await child(202)).toMatchObject({ documentId: null });
      });

      it('does not select a hidden related row just because the replacement is writable', async () => {
        const job = await run('update', { filter: { project: { name: 'Hidden' } }, values: { [name]: value([202]) } });
        expect(job.status, executionError?.stack).toBe(EXECUTION_STATUS.RESOLVED);
        expect(job.result).toEqual({ length: 0, data: [] });
        expect(await connected()).toEqual([201]);
        expect(await child(202)).toMatchObject({ documentId: null });
      });

      it('rejects multiple writable sources before replacing any child', async () => {
        await documents.model.update({ projectId: 101 }, { where: { id: 3 }, hooks: false });
        const job = await run('update', { filter: { project: { name: 'Visible' } }, values: { [name]: value([202]) } });
        expect(job.status).toBe(EXECUTION_STATUS.ERROR);
        expect(job.result.message).toMatch(/single source/i);
        expect(await connected()).toEqual([201]);
        expect(await child(202)).toMatchObject({ documentId: null });
      });

      it.each([false, true])('claims a legacy source only when child connections change: %s', async (change) => {
        const config = configFor(ownerCondition);
        config.rules.push({
          ...configFor({ type: 'isNull', operand: { type: 'field', path: 'tenantId' } }).rules[0],
          id: 'legacy-edit',
        });
        await save(documents, config);
        const before = await get(5);
        const job = await run('update', {
          filterByTk: 5,
          filter: { project: { name: 'Visible' } },
          values: { [name]: value(change ? [202] : []) },
        });
        expect(job.status, executionError?.stack).toBe(EXECUTION_STATUS.RESOLVED);
        expect(job.result.length).toBe(change ? 1 : 0);
        if (change) {
          expect(await get(5)).toMatchObject({ tenantId: 'B' });
          expect(await child(202)).toMatchObject({ documentId: 5, tenantId: 'B' });
        } else expect(await get(5)).toEqual(before);
        expect((await projects.model.findByPk(101)).get('tenantId')).toBe('H');
      });

      it('publishes source and child events only after all selected connections persist', async () => {
        const observed: Array<{ event: string; keys: number[] }> = [];
        const events = [
          `${documents.name}.afterUpdateWithAssociations`,
          `${target().name}.afterUpdateWithAssociations`,
        ];
        const listeners = events.map((event) => async (_record, options) => {
          observed.push({ event, keys: await connected(options.transaction) });
        });
        events.forEach((event, index) => app.db.on(event, listeners[index]));
        let job;
        try {
          job = await run('update', { filter: { [name]: { name: 'Owned' } }, values: { [name]: value([202]) } });
        } finally {
          events.forEach((event, index) => app.db.off(event, listeners[index]));
        }
        expect(job.status, executionError?.stack).toBe(EXECUTION_STATUS.RESOLVED);
        expect(observed).toEqual([
          { event: events[0], keys: [202] },
          { event: events[1], keys: [202] },
          { event: events[1], keys: [202] },
        ]);
      });

      it('rolls back the source and both child writes when a complete-association hook fails', async () => {
        const listener = async (record) => {
          if (record.getDataValue('id') === 202) throw new Error('selected child hook failed');
        };
        const event = `${target().name}.afterUpdateWithAssociations`;
        app.db.on(event, listener);
        let job;
        try {
          job = await run('update', {
            filter: { [name]: { name: 'Owned' } },
            values: { [name]: value([202]), name: 'No' },
          });
        } finally {
          app.db.off(event, listener);
        }
        expect(job.status).toBe(EXECUTION_STATUS.ERROR);
        expect(executionError?.message).toContain('selected child hook failed');
        expect(await get(1)).toMatchObject({ name: 'First' });
        expect(await connected()).toEqual([201]);
        expect(await child(202)).toMatchObject({ documentId: null });
      });

      it('does not replace an insufficient inherited transaction', async () => {
        const job = await run(
          'update',
          { filter: { project: { name: 'Visible' } }, values: { [name]: value([202]) } },
          'ordinary',
        );
        expect(job.status).toBe(EXECUTION_STATUS.ERROR);
        expect(job.result.message).toMatch(/sufficient isolation/i);
        expect(await connected()).toEqual([201]);
      });
    });
  });

  describe('single-reference writes with relationship selection', () => {
    it.each([undefined, 'serializable'] as const)(
      'selects and changes a reference in a %s transaction',
      async (inherited) => {
        const job = await run(
          'update',
          {
            filter: { project: { name: 'Visible' } },
            values: { project: 103, name: 'Reference changed' },
          },
          inherited,
        );
        expect(job.status, executionError?.stack).toBe(EXECUTION_STATUS.RESOLVED);
        expect(isolation).toBe('serializable');
        expect(job.result).toMatchObject({
          length: 1,
          data: [{ id: 1, name: 'Reference changed', projectId: 103, tenantId: 'B' }],
        });
        expect(job.result.data[0].project).toBeUndefined();
        expect(await get(4)).toMatchObject({ name: 'Other tenant', projectId: 101, tenantId: 'C' });
      },
    );

    it('allows a visible new target without requiring the old filter to match after writing', async () => {
      const job = await run('update', { filter: { project: { name: 'Owned' } }, values: { project: 101 } });
      expect(job.status, executionError?.stack).toBe(EXECUTION_STATUS.RESOLVED);
      expect(job.result).toMatchObject({ length: 1, data: [{ id: 3, projectId: 101 }] });
      expect((await projects.model.findByPk(101)).get('tenantId')).toBe('H');
    });

    it('clears the selected reference without requiring the original filter afterward', async () => {
      const job = await run('update', { filter: { project: { name: 'Visible' } }, values: { project: null } });
      expect(job.status, executionError?.stack).toBe(EXECUTION_STATUS.RESOLVED);
      expect(job.result).toMatchObject({ length: 1, data: [{ id: 1, projectId: null }] });
      expect(await get(4)).toMatchObject({ projectId: 101 });
    });

    it('rejects a hidden new target without changing the selected source', async () => {
      const job = await run('update', {
        filter: { project: { name: 'Visible' } },
        values: { project: 102, name: 'No' },
      });
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(executionError).toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      expect(await get(1)).toMatchObject({ projectId: 101, name: 'First' });
    });

    it('changes two references and scalar fields together', async () => {
      const job = await run('update', {
        filter: { project: { name: 'Visible' } },
        values: { project: 103, alternative: 101, name: 'Both' },
      });
      expect(job.status, executionError?.stack).toBe(EXECUTION_STATUS.RESOLVED);
      expect(await get(1)).toMatchObject({ projectId: 103, alternativeId: 101, name: 'Both' });
    });

    it('rejects the whole change when the second new reference is hidden', async () => {
      const job = await run('update', {
        filter: { project: { name: 'Visible' } },
        values: { project: 103, alternative: 102, name: 'No' },
      });
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(executionError).toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      expect(await get(1)).toMatchObject({ projectId: 101, alternativeId: null, name: 'First' });
    });

    it('retains an unchanged hidden reference without writing or resolving that target', async () => {
      await documents.model.update({ alternativeId: 102 }, { where: { id: 1 }, hooks: false });
      const before = await get(1);
      const job = await run('update', { filter: { project: { name: 'Visible' } }, values: { alternative: 102 } });
      expect(job.status, executionError?.stack).toBe(EXECUTION_STATUS.RESOLVED);
      expect(job.result.length).toBe(0);
      expect(await get(1)).toEqual(before);
    });

    it('does not select hidden related records because the new reference is readable', async () => {
      const job = await run('update', { filter: { project: { name: 'Hidden' } }, values: { project: 103 } });
      expect(job.status, executionError?.stack).toBe(EXECUTION_STATUS.RESOLVED);
      expect(job.result.length).toBe(0);
      expect(await get(2)).toMatchObject({ projectId: 102, name: 'Hidden target' });
    });

    it('rejects an explicit batch containing a visible but nonwritable source', async () => {
      const job = await run('update', {
        filterByTk: [1, 4],
        filter: { project: { name: 'Visible' } },
        values: { project: 103 },
      });
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(executionError).toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      expect(await get(1)).toMatchObject({ projectId: 101 });
      expect(await get(4)).toMatchObject({ projectId: 101 });
    });

    it('requires the old relationship filter for every explicit source key', async () => {
      const job = await run('update', {
        filterByTk: [1, 3],
        filter: { project: { name: 'Visible' } },
        values: { project: 103 },
      });
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(executionError).toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      expect(await get(1)).toMatchObject({ projectId: 101 });
      expect(await get(3)).toMatchObject({ projectId: 103 });
    });

    it.each([101, 103])('claims an editable legacy source only when reference %s changes it', async (target) => {
      const config = configFor(ownerCondition);
      config.rules.push({
        ...configFor({ type: 'isNull', operand: { type: 'field', path: 'tenantId' } }).rules[0],
        id: 'legacy-edit',
      });
      await save(documents, config);
      const before = await get(5);
      const job = await run('update', {
        filterByTk: 5,
        filter: { project: { name: 'Visible' } },
        values: { project: target },
      });
      expect(job.status, executionError?.stack).toBe(EXECUTION_STATUS.RESOLVED);
      expect(job.result.length).toBe(target === 101 ? 0 : 1);
      if (target === 101) expect(await get(5)).toEqual(before);
      else expect(await get(5)).toMatchObject({ projectId: 103, tenantId: 'B' });
      expect((await projects.model.findByPk(101)).get('tenantId')).toBe('H');
    });

    it.each(['tags', 'children'] as const)(
      'selects through readable %s while changing a single reference',
      async (relation) => {
        if (relation === 'tags') await links.model.create({ documentId: 1, projectId: 101 });
        else await children.model.create({ name: 'Visible', tenantId: 'H', documentId: 1 });
        const job = await run('update', {
          filter: { [relation]: { name: 'Visible' } },
          values: { project: 103 },
        });
        expect(job.status, executionError?.stack).toBe(EXECUTION_STATUS.RESOLVED);
        expect(job.result).toMatchObject({ length: 1, data: [{ id: 1, projectId: 103 }] });
        if (relation === 'tags') expect(await links.model.count()).toBe(1);
        else expect((await children.model.findOne()).get('tenantId')).toBe('H');
      },
    );

    it('preserves another owner when an explicit G rule authorizes the reference update', async () => {
      await save(
        documents,
        configFor({
          type: 'compare',
          operator: 'eq',
          left: { type: 'field', path: 'tenantId' },
          right: { type: 'literal', value: 'C' },
        }),
      );
      const job = await run('update', {
        filterByTk: 4,
        filter: { project: { name: 'Visible' } },
        values: { project: 103 },
      });
      expect(job.status, executionError?.stack).toBe(EXECUTION_STATUS.RESOLVED);
      expect(await get(4)).toMatchObject({ projectId: 103, tenantId: 'C' });
    });

    it('rejects a reference write in an inadequate inherited transaction', async () => {
      const job = await run(
        'update',
        { filter: { project: { name: 'Visible' } }, values: { project: 103 } },
        'ordinary',
      );
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(job.result.message).toMatch(/sufficient isolation/i);
      expect(await get(1)).toMatchObject({ projectId: 101 });
    });

    it('rolls back references and scalar fields when a later source hook fails', async () => {
      failLater = true;
      const job = await run('update', {
        filter: { project: { name: { $in: ['Visible', 'Owned'] } } },
        values: { project: 101, name: 'No' },
      });
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(executionError?.message).toContain('later selection write failed');
      expect(await get(1)).toMatchObject({ projectId: 101, name: 'First' });
      expect(await get(3)).toMatchObject({ projectId: 103, name: 'Second' });
    });
  });

  describe.each(['update', 'destroy'] as const)('%s selection', (action) => {
    it('uses readable related rows but writes only ownership-authorized sources', async () => {
      const job = await run(action, params(action, { project: { name: 'Visible' } }));
      expect(job.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(isolation).toBe('serializable');
      expect(action === 'update' ? job.result.length : job.result).toBe(1);
      expect(await get(1)).toEqual(
        action === 'update' ? expect.objectContaining({ name: 'Selected', tenantId: 'B' }) : undefined,
      );
      expect(await get(4)).toMatchObject({ name: 'Other tenant', tenantId: 'C' });
      expect(await get(5)).toMatchObject({ name: 'Legacy', tenantId: null });
      expect((await projects.model.findByPk(101)).get('tenantId')).toBe('H');
    });
    it('cannot match a hidden related row', async () => {
      const job = await run(action, params(action, { project: { name: 'Hidden' } }));
      expect(job.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(action === 'update' ? job.result.length : job.result).toBe(0);
      expect(await get(2)).toMatchObject({ name: 'Hidden target', tenantId: 'B' });
    });
    it('honors a configured G grant for another owner without transferring ownership', async () => {
      await save(
        documents,
        configFor({
          type: 'compare',
          operator: 'eq',
          left: { type: 'field', path: 'tenantId' },
          right: { type: 'literal', value: 'C' },
        }),
      );
      const job = await run(action, params(action, { project: { name: 'Visible' } }, { filterByTk: 4 }));
      expect(job.status, executionError?.stack).toBe(EXECUTION_STATUS.RESOLVED);
      expect(action === 'update' ? job.result.length : job.result).toBe(1);
      expect(await get(4)).toEqual(
        action === 'update' ? expect.objectContaining({ name: 'Selected', tenantId: 'C' }) : undefined,
      );
      expect(await get(1)).toMatchObject({ name: 'First', tenantId: 'B' });
    });
    it('does not turn visibility-only source access into write permission', async () => {
      const job = await run(action, params(action, { project: { name: 'Visible' } }, { filterByTk: [1, 4] }));
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(await get(1)).toMatchObject({ name: 'First' });
      expect(await get(4)).toMatchObject({ name: 'Other tenant', tenantId: 'C' });
    });
    it('rolls back when a concurrent related-row change invalidates the active snapshot', async () => {
      const competitor = isolatedPostgresDatabase(postgresUrl!);
      const qi = app.db.sequelize.getQueryInterface();
      const documentsTable = qi.queryGenerator.quoteTable(documents.model.getTableName());
      const projectsTable = qi.queryGenerator.quoteTable(projects.model.getTableName());
      let notifications = 0;
      interfere = async (_record, options) => {
        options.transaction.afterCommit(() => {
          notifications++;
        });
        await competitor.sequelize.transaction(
          { isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE },
          async (transaction) => {
            await competitor.sequelize.query(`SELECT id FROM ${documentsTable} WHERE id = 1`, { transaction });
            await competitor.sequelize.query(`UPDATE ${projectsTable} SET name = 'Revoked' WHERE id = 101`, {
              transaction,
            });
          },
        );
        await projects.model.findByPk(101, { transaction: options.transaction, lock: options.transaction.LOCK.UPDATE });
      };
      try {
        await expect(run(action, params(action, { project: { name: 'Visible' } }), 'serializable')).rejects.toThrow(
          /Concurrent authorization changed/i,
        );
        expect(await get(1)).toMatchObject({ name: 'First', tenantId: 'B' });
        expect((await projects.model.findByPk(101)).get('name')).toBe('Revoked');
        expect(notifications).toBe(0);
      } finally {
        await competitor.close();
      }
    });
    it('supports negated existence only within the related readable scope', async () => {
      const job = await run(action, params(action, { 'project.$notExists': true }));
      expect(job.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(action === 'update' ? job.result.length : job.result).toBe(1);
      expect(await get(2)).toEqual(action === 'update' ? expect.objectContaining({ name: 'Selected' }) : undefined);
      expect(await get(1)).toMatchObject({ name: 'First' });
      expect(await get(3)).toMatchObject({ name: 'Second' });
    });
    it('rejects relationship metadata changes during preparation', async () => {
      const read = store.read.bind(store);
      const relation = documents.model.associations.project;
      vi.spyOn(store, 'read').mockImplementation(async (source) => {
        const config = await read(source);
        if (source.collectionName === projects.name) documents.model.associations.project = Object.create(relation);
        return config;
      });
      try {
        const job = await run(action, params(action, { project: { name: 'Visible' } }), 'serializable');
        expect(job.status).toBe(EXECUTION_STATUS.ERROR);
        expect(job.result.message).toMatch(/metadata|changed/i);
        expect(await get(1)).toMatchObject({ name: 'First' });
      } finally {
        documents.model.associations.project = relation;
      }
    });
    it('rejects missing related configuration instead of using the old tenant filter', async () => {
      const read = store.read.bind(store);
      vi.spyOn(store, 'read').mockImplementation((source) =>
        source.collectionName === projects.name ? Promise.resolve(null) : read(source),
      );
      const job = await run(action, params(action, { project: { name: 'Visible' } }), 'serializable');
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(await get(1)).toMatchObject({ name: 'First' });
    });
    it('rejects metadata changes made by a business hook and rolls back', async () => {
      const relation = documents.model.associations.project;
      interfere = async () => {
        documents.model.associations.project = Object.create(relation);
      };
      try {
        const job = await run(action, params(action, { project: { name: 'Visible' } }));
        expect(job.status).toBe(EXECUTION_STATUS.ERROR);
        expect(job.result.message).toMatch(/metadata|changed/i);
        expect(await get(1)).toMatchObject({ name: 'First' });
      } finally {
        documents.model.associations.project = relation;
      }
    });
    it('rechecks the filter for explicit record keys and rejects the whole batch', async () => {
      const job = await run(action, params(action, { project: { name: 'Visible' } }, { filterByTk: [1, 2] }));
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(await get(1)).toMatchObject({ name: 'First' });
      expect(await get(2)).toMatchObject({ name: 'Hidden target' });
    });
    it('does not upgrade or replace an inadequate inherited transaction', async () => {
      const job = await run(action, params(action, { project: { name: 'Visible' } }), 'ordinary');
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(job.result.message).toMatch(/sufficient isolation/i);
      expect(await get(1)).toMatchObject({ name: 'First' });
    });
    it('rolls back an earlier write when a later selected record fails', async () => {
      failLater = true;
      const job = await run(action, params(action, { project: { name: { $in: ['Visible', 'Owned'] } } }));
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(job.result.message).toMatch(/later selection write failed/i);
      expect(await get(1)).toMatchObject({ name: 'First' });
      expect(await get(3)).toMatchObject({ name: 'Second' });
    });
  });
});

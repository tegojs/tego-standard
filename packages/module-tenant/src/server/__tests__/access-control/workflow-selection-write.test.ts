import { createMockServer, type MockServer } from '@tachybase/test';
import { ACL, Transaction } from '@tego/server';

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
  let children;
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
    await children.model.destroy({ where: {}, hooks: false });
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

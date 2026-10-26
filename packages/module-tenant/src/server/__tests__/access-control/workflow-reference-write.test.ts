import { createMockServer, type MockServer } from '@tachybase/test';
import { ACL, Repository, Transaction } from '@tego/server';

import { EXECUTION_STATUS } from '../../../../../module-workflow/src/server/constants';
import type WorkflowPlugin from '../../../../../module-workflow/src/server/Plugin';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessConfigHistory } from '../../access-control/config-history';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import type { AccessCondition } from '../../access-control/types';
import { AccessWorkflowRootHandler } from '../../access-control/workflow-root-handler';
import { AccessWorkflowWriteTransactionPlanner } from '../../access-control/workflow-write-transaction';
import { isolatedPostgresDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const supportsDeferredAssociationEvents =
  typeof (Repository.prototype as unknown as Record<string, unknown>).withDeferredAssociationEvents === 'function';

describe.runIf(!!postgresUrl)('configured workflow existing reference writes', () => {
  let app: MockServer;
  let plugin: WorkflowPlugin;
  let adapter: AccessAclScopeAdapter;
  let store: AccessConfigStore;
  let handler: AccessWorkflowRootHandler;
  let planner: AccessWorkflowWriteTransactionPlanner;
  let planning: boolean;
  let planningCalls: number;
  let actualIsolation: string | undefined;
  let documents;
  let projects;
  let source;
  let target;
  let workflow;
  let request;
  let tamper: boolean;
  let failLater: boolean;
  let release: boolean;
  let transformInput: ((input) => void) | undefined;
  let afterWrite: (() => Promise<void>) | undefined;
  const joinIdentities = new Map();
  const joins = new Map();
  const dependents = new Map();
  const dependentIdentities = new Map();
  const identity = (collection) =>
    collection === documents
      ? source
      : collection === projects
        ? target
        : (joinIdentities.get(collection) ?? dependentIdentities.get(collection));
  const targetConfig = () => ({
    ...configFor(ownerCondition),
    rules: [
      ...configFor(ownerCondition).rules,
      {
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
        id: 'visible-target',
      },
    ],
  });

  beforeAll(async () => {
    const checked = isolatedPostgresDatabase(postgresUrl!);
    const database = checked.options;
    await checked.close();
    app = await createMockServer({
      database,
      plugins: [
        'error-handler',
        'collection',
        'user',
        [
          'workflow',
          {
            createTransactionPlanner: (target) => {
              planningCalls++;
              return planner.plan(target);
            },
            updateTransactionPlanner: (target) => {
              planningCalls++;
              return planner.plan(target);
            },
            createResolver: () => async (input) => {
              request = input;
              transformInput?.(input);
              if (planning) {
                const [rows] = await app.db.sequelize.query(
                  "SELECT current_setting('transaction_isolation') AS transaction_isolation",
                  {
                    transaction: input.transaction,
                  },
                );
                actualIsolation = (rows[0] as { transaction_isolation: string }).transaction_isolation;
              }
              return handler.create(input);
            },
            updateResolver: () => async (input) => {
              request = input;
              transformInput?.(input);
              if (planning) {
                const [rows] = await app.db.sequelize.query(
                  "SELECT current_setting('transaction_isolation') AS transaction_isolation",
                  {
                    transaction: input.transaction,
                  },
                );
                actualIsolation = (rows[0] as { transaction_isolation: string }).transaction_isolation;
              }
              const result = await handler.update(input);
              await afterWrite?.();
              return result;
            },
          },
        ],
      ],
    });
    plugin = app.pm.get('workflow') as WorkflowPlugin;
    const repo = app.db.getRepository('collections');
    const projectRow = await repo.create({
      context: {},
      values: {
        name: 'workflowReferenceProjects',
        fields: [
          { name: 'name', type: 'string' },
          { name: 'tenantId', type: 'string' },
        ],
      },
    });
    projects = app.db.getCollection('workflowReferenceProjects');
    await projects.model.sync();
    const documentRow = await repo.create({
      context: {},
      values: {
        name: 'workflowReferenceDocuments',
        fields: [
          { name: 'name', type: 'string' },
          { name: 'tenantId', type: 'string' },
          { name: 'project', type: 'belongsTo', target: projects.name, foreignKey: 'projectId' },
          { name: 'alternative', type: 'belongsTo', target: projects.name, foreignKey: 'alternativeId' },
          { name: 'parent', type: 'belongsTo', target: 'workflowReferenceDocuments', foreignKey: 'parentId' },
        ],
      },
    });
    documents = app.db.getCollection('workflowReferenceDocuments');
    await documents.model.sync();
    source = { dataSourceKey: 'main', collectionKey: documentRow.get('key'), collectionName: documents.name };
    target = { dataSourceKey: 'main', collectionKey: projectRow.get('key'), collectionName: projects.name };
    for (const name of ['tags', 'otherTags']) {
      const row = await repo.create({
        context: {},
        values: { name: `workflowReference_${name}`, timestamps: false, fields: [] },
      });
      const join = app.db.getCollection(`workflowReference_${name}`);
      documents.setField(name, {
        type: 'belongsToMany',
        target: projects.name,
        through: join.name,
        foreignKey: 'documentId',
        otherKey: 'projectId',
      });
      await join.model.sync({ alter: true });
      joins.set(name, join);
      joinIdentities.set(join, { dataSourceKey: 'main', collectionKey: row.get('key'), collectionName: join.name });
    }
    for (const [name, type] of [
      ['children', 'hasMany'],
      ['profile', 'hasOne'],
    ]) {
      const row = await repo.create({
        context: {},
        values: {
          name: `workflowReference_${name}`,
          timestamps: false,
          fields: [
            { name: 'name', type: 'string' },
            { name: 'tenantId', type: 'string' },
          ],
        },
      });
      const dependent = app.db.getCollection(`workflowReference_${name}`);
      documents.setField(name, { type, target: dependent.name, foreignKey: 'documentId' });
      dependent.setField('document', { type: 'belongsTo', target: documents.name, foreignKey: 'documentId' });
      await dependent.model.sync({ alter: true });
      dependents.set(name, dependent);
      dependentIdentities.set(dependent, {
        dataSourceKey: 'main',
        collectionKey: row.get('key'),
        collectionName: dependent.name,
      });
    }
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
    const key = (collection) => accessCollectionKey(identity(collection)!);
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
      (input) => plugin.captureDataOperationAuthority(input),
    );
    app.db.on(`${documents.name}.afterUpdate`, async (record, options) => {
      if (failLater && record.getDataValue('id') === 3) throw new Error('later reference update failed');
      if (tamper)
        await documents.model.update(
          { projectId: 102 },
          { where: { id: record.getDataValue('id') }, transaction: options.transaction, hooks: false },
        );
      if (release) adapter.release(request.context);
    });
    app.db.on(`${documents.name}.afterCreate`, async (record, options) => {
      if (tamper)
        await documents.model.update(
          { projectId: 102 },
          { where: { id: record.getDataValue('id') }, transaction: options.transaction, hooks: false },
        );
      if (release) adapter.release(request.context);
    });
  });
  async function save(identity, config) {
    const current = await store.read(identity);
    await store.save(identity, { ...config, revision: current?.revision ?? 0 }, { userId: 28 });
  }
  beforeEach(async () => {
    tamper = failLater = release = false;
    planning = false;
    planningCalls = 0;
    actualIsolation = undefined;
    request = undefined;
    transformInput = undefined;
    afterWrite = undefined;
    await save(source, configFor(ownerCondition));
    await save(target, targetConfig());
    for (const dependent of dependents.values()) {
      await save(identity(dependent), targetConfig());
      await dependent.model.destroy({ where: {}, hooks: false });
    }
    for (const join of joins.values()) {
      // The same explicit shared configuration is usable by reads and configured node writes.
      await save(joinIdentities.get(join), {
        ...configFor({ type: 'constant', value: true }),
        ownership: { enabled: false },
      });
      await join.model.destroy({ where: {}, hooks: false });
    }
    await documents.model.destroy({ where: {}, hooks: false });
    await projects.model.destroy({ where: {}, hooks: false });
    await projects.model.bulkCreate([
      { id: 101, name: 'Visible', tenantId: 'H' },
      { id: 102, name: 'Hidden', tenantId: 'C' },
      { id: 103, name: 'Owned', tenantId: 'B' },
      { id: 104, name: 'Legacy', tenantId: null },
    ]);
    await documents.model.bulkCreate([
      { id: 1, name: 'First', tenantId: 'B', projectId: 101 },
      { id: 2, name: 'Other', tenantId: 'C', projectId: 102 },
      { id: 3, name: 'Second', tenantId: 'B', projectId: 103 },
      { id: 5, name: 'Legacy', tenantId: null },
    ]);
    for (const dependent of dependents.values())
      await dependent.model.bulkCreate([
        { id: 201, name: 'Owned', tenantId: 'B', documentId: null },
        { id: 202, name: 'Visible', tenantId: 'H', documentId: null },
        { id: 203, name: 'Hidden', tenantId: 'C', documentId: null },
        { id: 204, name: 'Legacy', tenantId: null, documentId: null },
        { id: 205, name: 'Owned old', tenantId: 'B', documentId: 3 },
        { id: 206, name: 'Owned other', tenantId: 'B', documentId: 2 },
      ]);
    workflow = await app.db.getRepository('workflows').create({
      values: {
        title: 'Reference write',
        type: 'collection',
        enabled: true,
        sync: true,
        config: { collection: 'referenceEvents', mode: 1 },
      },
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const join of joins.values()) join.model.removeHook('afterBulkCreate', 'workflowLinkTest');
    await workflow?.update({ enabled: false });
  });
  afterAll(async () => {
    if (app) {
      const tables = Object.values(app.db.sequelize.models).map((model) => model.getTableName());
      await app.destroy();
      const cleanup = isolatedPostgresDatabase(postgresUrl!);
      try {
        for (const table of tables) await cleanup.sequelize.getQueryInterface().dropTable(table, { cascade: true });
      } finally {
        await cleanup.close();
      }
    }
  });
  const get = async (id = 1) => (await documents.model.findByPk(id))?.get({ plain: true });
  const linked = async (id = 1, name = 'tags') =>
    (await joins.get(name).model.findAll({ where: { documentId: id }, order: [['projectId', 'ASC']] })).map((row) =>
      row.getDataValue('projectId'),
    );
  async function execute(kind: 'create' | 'update', params: object, serializable: boolean | null = true) {
    await workflow.createNode({ type: kind, config: { collection: documents.name, params } });
    const transaction =
      serializable === null
        ? undefined
        : await app.db.sequelize.transaction({
            isolationLevel: serializable
              ? Transaction.ISOLATION_LEVELS.SERIALIZABLE
              : Transaction.ISOLATION_LEVELS.READ_COMMITTED,
          });
    try {
      await plugin.trigger(workflow, {}, { transaction, context: { state: { currentTenantId: 'B' } } });
      const [execution] = await workflow.getExecutions({ transaction, order: [['id', 'DESC']] });
      const [job] = await execution.getJobs({ transaction });
      const result = { status: execution.status, result: job.result };
      if (transaction) {
        if (execution.status === EXECUTION_STATUS.RESOLVED) await transaction.commit();
        else await transaction.rollback();
      }
      return result;
    } catch (error) {
      if (transaction && !(transaction as Transaction & { finished?: string }).finished) await transaction.rollback();
      throw error;
    }
  }

  describe.runIf(supportsDeferredAssociationEvents)('new core serialization failures', () => {
    it.each([
      { inherited: false, stage: 'afterWrite' },
      { inherited: true, stage: 'afterWrite' },
      { inherited: true, stage: 'write' },
    ])('preserves the conflict and suppresses notifications for %j', async ({ inherited, stage }) => {
      await save(
        source,
        configFor({
          type: 'exists',
          path: 'project',
          condition: {
            type: 'compare',
            operator: 'eq',
            left: { type: 'field', path: 'name' },
            right: { type: 'literal', value: 'Owned' },
          },
        }),
      );
      const competitor = isolatedPostgresDatabase(postgresUrl!);
      const qi = app.db.sequelize.getQueryInterface();
      const quoteTable = (table) => qi.queryGenerator.quoteTable(table);
      let writes = 0;
      let notifications = 0;
      const revoke = async () => {
        await competitor.sequelize.transaction(
          { isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE },
          async (transaction) => {
            await competitor.sequelize.query(
              `SELECT id FROM ${quoteTable(documents.model.getTableName())} WHERE id = 3`,
              { transaction },
            );
            await competitor.sequelize.query(
              `UPDATE ${quoteTable(projects.model.getTableName())} SET name = 'Revoked' WHERE id = 103`,
              { transaction },
            );
          },
        );
      };
      const listener = async (_record, options) => {
        writes++;
        options.transaction.afterCommit(() => {
          notifications++;
        });
        if (stage === 'write') await revoke();
      };
      if (stage === 'afterWrite') afterWrite = revoke;
      app.db.on(`${documents.name}.afterUpdate`, listener);
      planning = true;
      try {
        const attempt = execute(
          'update',
          { filterByTk: 3, values: { name: 'Must roll back' } },
          inherited ? true : null,
        );
        if (inherited)
          await expect(attempt).rejects.toMatchObject(
            stage === 'write' ? { code: 'ACCESS_MUTATION_CONFLICT', status: 409 } : { original: { code: '40001' } },
          );
        else {
          const job = await attempt;
          expect(job.status).toBe(EXECUTION_STATUS.ERROR);
          expect(job.result.message).toMatch(/serializ|concurrent/i);
        }
        expect(writes).toBe(1);
        expect(notifications).toBe(0);
        expect((await get(3)).name).toBe('Second');
        expect((await projects.model.findByPk(103)).getDataValue('name')).toBe('Revoked');
      } finally {
        app.db.off(`${documents.name}.afterUpdate`, listener);
        await competitor.close();
      }
    });
  });

  it.each(['create', 'update'] as const)(
    'refuses %s links before writing when the core lifecycle capability is missing',
    async (kind) => {
      const repository = documents.repository;
      const previous = Object.getOwnPropertyDescriptor(repository, 'withDeferredAssociationEvents');
      Object.defineProperty(repository, 'withDeferredAssociationEvents', { value: undefined, configurable: true });
      let writes = 0;
      const listener = () => {
        writes++;
      };
      const event = `${documents.name}.after${kind === 'create' ? 'Create' : 'Update'}`;
      app.db.on(event, listener);
      try {
        const job = await execute(kind, {
          ...(kind === 'update' ? { filterByTk: 1 } : {}),
          values: { ...(kind === 'create' ? { id: 100 } : {}), name: 'Must not write', tags: [101] },
        });
        expect(job.status).toBe(EXECUTION_STATUS.ERROR);
        expect(job.result.message).toMatch(/deferred association events/i);
        expect(writes).toBe(0);
        expect(await get(100)).toBeUndefined();
        expect((await get()).name).toBe('First');
        expect(await linked()).toEqual([]);
      } finally {
        app.db.off(event, listener);
        if (previous) Object.defineProperty(repository, 'withDeferredAssociationEvents', previous);
        else delete repository.withDeferredAssociationEvents;
      }
    },
  );

  describe.each(['children', 'profile'])('target foreign-key capability gate: %s', (name) => {
    it.each(['source', 'target'])('rejects a missing %s lifecycle capability before any source write', async (part) => {
      const repository = (part === 'source' ? documents : dependents.get(name)).repository;
      const previous = Object.getOwnPropertyDescriptor(repository, 'withDeferredAssociationEvents');
      Object.defineProperty(repository, 'withDeferredAssociationEvents', { value: undefined, configurable: true });
      let writes = 0;
      const listener = () => {
        writes++;
      };
      app.db.on(`${documents.name}.beforeUpdate`, listener);
      try {
        const job = await execute('update', {
          filterByTk: 3,
          values: { name: 'No', [name]: name === 'children' ? [201] : 201 },
        });
        expect(job.status).toBe(EXECUTION_STATUS.ERROR);
        expect(job.result.message).toMatch(/deferred association events/i);
        expect(writes).toBe(0);
        expect((await get(3)).name).toBe('Second');
        expect((await dependents.get(name).model.findByPk(201)).getDataValue('documentId')).toBeNull();
      } finally {
        app.db.off(`${documents.name}.beforeUpdate`, listener);
        if (previous) Object.defineProperty(repository, 'withDeferredAssociationEvents', previous);
        else delete repository.withDeferredAssociationEvents;
      }
    });
  });

  describe.runIf(supportsDeferredAssociationEvents)('target foreign-key workflow updates', () => {
    it('sets multiple children, deduplicates equivalent keys and preserves zero', async () => {
      const children = dependents.get('children');
      await children.model.create({ id: 0, name: 'Owned zero', tenantId: 'B' });
      const job = await execute('update', { filterByTk: 3, values: { children: [0, 201, '0201'] } });
      expect(job.status, job.result?.stack).toBe(EXECUTION_STATUS.RESOLVED);
      const rows = await children.model.findAll({ where: { documentId: 3 }, order: [['id', 'ASC']] });
      expect(rows.map((row) => row.getDataValue('id'))).toEqual([0, 201]);
    });
    it.each([
      ['children', null],
      ['children', 201],
      ['children', [{ id: 201 }]],
      ['children', Array.from({ length: 1001 }, () => 201)],
      ['profile', []],
      ['profile', { id: 201 }],
      ['profile', '_'],
    ])('rejects invalid %s target values %j', async (name, values) => {
      const job = await execute('update', { filterByTk: 3, values: { [name as string]: values } });
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect((await dependents.get(name).model.findByPk(205)).getDataValue('documentId')).toBe(3);
    });
    it.each(['prototype', 'sparse', 'symbol'])('rejects an original %s child array before copying', async (part) => {
      transformInput = (input) => {
        const values = input.params.values.children;
        if (part === 'prototype') Object.setPrototypeOf(values, Object.create(Array.prototype));
        else if (part === 'sparse') delete values[0];
        else values[Symbol('extra')] = true;
      };
      const job = await execute('update', { filterByTk: 3, values: { children: [201] } });
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect((await dependents.get('children').model.findByPk(201)).getDataValue('documentId')).toBeNull();
    });
    describe.each(['children', 'profile'])('%s', (name) => {
      const value = (keys: number[]) => (name === 'children' ? keys : (keys[0] ?? null));
      const connected = async (id = 3, transaction?) =>
        (
          await dependents.get(name).model.findAll({ where: { documentId: id }, order: [['id', 'ASC']], transaction })
        ).map((row) => row.getDataValue('id'));
      it('saves scalar fields and existing targets in a node-planned transaction', async () => {
        planning = true;
        const job = await execute('update', { filterByTk: 3, values: { name: 'Changed', [name]: value([201]) } }, null);
        expect(job.status, job.result?.stack).toBe(EXECUTION_STATUS.RESOLVED);
        expect(actualIsolation).toBe('serializable');
        expect(await connected()).toEqual([201]);
        expect(job.result).toMatchObject({ length: 1, data: [{ id: 3, name: 'Changed', tenantId: 'B' }] });
        expect(job.result.data[0][name]).toBeUndefined();
        expect((await dependents.get(name).model.findByPk(205)).getDataValue('documentId')).toBeNull();
      });
      it('publishes source and every target lifecycle only after the full replacement', async () => {
        const observed: Array<{ event: string; keys: number[] }> = [];
        const events = [
          `${documents.name}.afterUpdateWithAssociations`,
          `${dependents.get(name).name}.afterUpdateWithAssociations`,
        ];
        const listeners = events.map((event) => async (_record, options) => {
          observed.push({ event, keys: await connected(3, options.transaction) });
        });
        events.forEach((event, index) => app.db.on(event, listeners[index]));
        let job;
        try {
          job = await execute('update', { filterByTk: 3, values: { [name]: value([201]) } });
        } finally {
          events.forEach((event, index) => app.db.off(event, listeners[index]));
        }
        expect(job.status, job.result?.stack).toBe(EXECUTION_STATUS.RESOLVED);
        expect(observed).toEqual([
          { event: events[0], keys: [201] },
          { event: events[1], keys: [201] },
          { event: events[1], keys: [201] },
        ]);
      });
      it('clears the existing target set', async () => {
        const job = await execute('update', { filterByTk: 3, values: { [name]: value([]) } });
        expect(job.status, job.result?.stack).toBe(EXECUTION_STATUS.RESOLVED);
        expect(job.result.length).toBe(1);
        expect(await connected()).toEqual([]);
      });
      it('returns zero for an empty source query without checking its hidden target', async () => {
        const empty = await execute('update', { filter: { id: 999 }, values: { [name]: value([203]) } });
        expect(empty).toEqual({ status: EXECUTION_STATUS.RESOLVED, result: { length: 0, data: [] } });
      });
      it('supports a filter selecting one writable source', async () => {
        const one = await execute('update', { filter: { id: 3 }, values: { [name]: value([201]) } });
        expect(one.status, one.result?.stack).toBe(EXECUTION_STATUS.RESOLVED);
        expect(await connected()).toEqual([201]);
      });
      it('rejects creating a source with unadapted child bindings', async () => {
        const job = await execute('create', { values: { id: 100, [name]: value([201]) } });
        expect(job.status).toBe(EXECUTION_STATUS.ERROR);
        expect(await get(100)).toBeUndefined();
      });
      it('rejects a changed target event method after the source write', async () => {
        const repository = dependents.get(name).repository;
        const previous = Object.getOwnPropertyDescriptor(repository, 'withDeferredAssociationEvents');
        const listener = () => {
          Object.defineProperty(repository, 'withDeferredAssociationEvents', {
            value: () => Promise.resolve(),
            configurable: true,
          });
        };
        app.db.on(`${documents.name}.afterUpdate`, listener);
        let job;
        try {
          job = await execute('update', { filterByTk: 3, values: { name: 'No', [name]: value([201]) } });
        } finally {
          app.db.off(`${documents.name}.afterUpdate`, listener);
          if (previous) Object.defineProperty(repository, 'withDeferredAssociationEvents', previous);
          else delete repository.withDeferredAssociationEvents;
        }
        expect(job.status).toBe(EXECUTION_STATUS.ERROR);
        expect(await connected()).toEqual([205]);
        expect((await get(3)).name).toBe('Second');
      });
      it('does not update, notify or claim unchanged connections', async () => {
        let calls = 0;
        const listener = () => {
          calls++;
        };
        app.db.on(`${documents.name}.afterUpdateWithAssociations`, listener);
        let job;
        try {
          job = await execute('update', { filterByTk: 3, values: { [name]: value([205]) } });
        } finally {
          app.db.off(`${documents.name}.afterUpdateWithAssociations`, listener);
        }
        expect(job.status, job.result?.stack).toBe(EXECUTION_STATUS.RESOLVED);
        expect(job.result).toEqual({ length: 0, data: [] });
        expect(calls).toBe(0);
      });
      it.each([202, 203, 999])('rejects changing a visibility-only, hidden or missing target %s', async (id) => {
        const job = await execute('update', { filterByTk: 3, values: { name: 'No', [name]: value([id]) } });
        expect(job.status).toBe(EXECUTION_STATUS.ERROR);
        expect(await connected()).toEqual([205]);
        expect((await get(3)).name).toBe('Second');
      });
      it('checks G for the old target implicitly removed by replacement', async () => {
        await dependents.get(name).model.update({ tenantId: 'H', name: 'Visible' }, { where: { id: 205 } });
        const job = await execute('update', { filterByTk: 3, values: { [name]: value([201]) } });
        expect(job.status).toBe(EXECUTION_STATUS.ERROR);
        expect(await connected()).toEqual([205]);
      });
      it('requires G on the source itself', async () => {
        await save(source, configFor({ type: 'constant', value: true }, 'visibility'));
        const job = await execute('update', { filterByTk: 3, values: { [name]: value([201]) } });
        expect(job.status).toBe(EXECUTION_STATUS.ERROR);
        expect(await connected()).toEqual([205]);
      });
      it.each([false, true])('claims historical source and target only for actual changes=%s', async (changed) => {
        const legacy: AccessCondition = {
          type: 'any',
          children: [ownerCondition, { type: 'isNull', operand: { type: 'field', path: 'tenantId' } }],
        };
        await save(source, configFor(legacy));
        await save(identity(dependents.get(name)), {
          ...targetConfig(),
          rules: [...configFor(legacy).rules, ...targetConfig().rules.filter((rule) => rule.category === 'visibility')],
        });
        if (!changed) await dependents.get(name).model.update({ documentId: 5 }, { where: { id: 204 } });
        const job = await execute('update', { filterByTk: 5, values: { [name]: value([204]) } });
        expect(job.status, job.result?.stack).toBe(EXECUTION_STATUS.RESOLVED);
        expect((await get(5)).tenantId).toBe(changed ? 'B' : null);
        expect((await dependents.get(name).model.findByPk(204)).getDataValue('tenantId')).toBe(changed ? 'B' : null);
        expect(job.result.length).toBe(changed ? 1 : 0);
      });
      it('rolls back both sides and notifications when a target lifecycle listener fails', async () => {
        let notifications = 0;
        const event = `${dependents.get(name).name}.afterUpdateWithAssociations`;
        const listener = (_row, options) => {
          options.transaction.afterCommit(() => {
            notifications++;
          });
          throw new Error('child lifecycle failed');
        };
        app.db.on(event, listener);
        let job;
        try {
          job = await execute('update', { filterByTk: 3, values: { name: 'No', [name]: value([201]) } });
        } finally {
          app.db.off(event, listener);
        }
        expect(job.status).toBe(EXECUTION_STATUS.ERROR);
        expect(job.result.message).toBe('child lifecycle failed');
        expect(notifications).toBe(0);
        expect(await connected()).toEqual([205]);
        expect((await get(3)).name).toBe('Second');
      });
      it.each(['connections', 'ownership'])('rejects listener changes to %s after persistence', async (part) => {
        const event = `${documents.name}.afterUpdateWithAssociations`;
        const listener = async (_row, options) => {
          if (part === 'connections')
            await dependents
              .get(name)
              .model.update({ documentId: 3 }, { where: { id: 203 }, transaction: options.transaction, hooks: false });
          else
            await documents.model.update(
              { tenantId: 'C' },
              { where: { id: 3 }, transaction: options.transaction, hooks: false },
            );
        };
        app.db.on(event, listener);
        let job;
        try {
          job = await execute('update', { filterByTk: 3, values: { [name]: value([201]) } });
        } finally {
          app.db.off(event, listener);
        }
        expect(job.status).toBe(EXECUTION_STATUS.ERROR);
        expect(await connected()).toEqual([205]);
        expect((await get(3)).tenantId).toBe('B');
      });
      it('captures target IDs and tenant before configuration awaits', async () => {
        const read = store.read.bind(store);
        vi.spyOn(store, 'read').mockImplementation(async (source) => {
          const result = await read(source);
          request.params.values[name] = value([203]);
          request.context.state.currentTenantId = 'C';
          return result;
        });
        const job = await execute('update', { filterByTk: 3, values: { [name]: value([201]) } });
        expect(job.status, job.result?.stack).toBe(EXECUTION_STATUS.RESOLVED);
        expect(await connected()).toEqual([201]);
      });
      it.each([
        { filterByTk: [1, 3] },
        { individualHooks: false },
        { values: { project: 103 } },
        { values: { tags: [103] } },
      ])('refuses an unadapted batch or mixed write %j before any partial change', async (extra) => {
        const job = await execute('update', {
          filterByTk: 3,
          ...extra,
          values: { [name]: value([201]), ...('values' in extra ? extra.values : {}) },
        });
        expect(job.status).toBe(EXECUTION_STATUS.ERROR);
        expect(await connected()).toEqual([205]);
      });
    });
  });

  describe('node-owned transactions planned from written fields', () => {
    it.each([
      ['create', 'project', 101],
      ['update', 'project', 101],
      ['create', 'project', null],
      ['update', 'project', null],
      ['create', 'parent', 1],
      ['update', 'parent', 1],
    ] as const)('plans %s with %s = %s using real serializable isolation', async (kind, field, key) => {
      planning = true;
      const job = await execute(
        kind,
        {
          ...(kind === 'update' ? { filterByTk: 3 } : {}),
          values: { ...(kind === 'create' ? { id: 100 } : {}), [field]: key },
        },
        null,
      );
      expect(job.status, job.result?.stack).toBe(EXECUTION_STATUS.RESOLVED);
      expect(planningCalls).toBe(1);
      expect(actualIsolation).toBe('serializable');
      expect((request.transaction as Transaction & { finished?: string }).finished).toBe('commit');
      expect((await get(kind === 'create' ? 100 : 3))[field === 'parent' ? 'parentId' : 'projectId']).toBe(key);
    });
    it.each(['create', 'update'] as const)('keeps root-only %s on the database default isolation', async (kind) => {
      planning = true;
      const job = await execute(
        kind,
        {
          ...(kind === 'update' ? { filterByTk: 3 } : {}),
          values: { ...(kind === 'create' ? { id: 100 } : {}), name: 'Scalar' },
        },
        null,
      );
      expect(job.status, job.result?.stack).toBe(EXECUTION_STATUS.RESOLVED);
      expect(planningCalls).toBe(1);
      expect(actualIsolation).toBe('read committed');
      expect((await get(kind === 'create' ? 100 : 3)).name).toBe('Scalar');
    });
    it.each(['create', 'update'] as const)('does not turn %s transaction planning into target access', async (kind) => {
      planning = true;
      const job = await execute(
        kind,
        {
          ...(kind === 'update' ? { filterByTk: 3 } : {}),
          values: { ...(kind === 'create' ? { id: 100 } : {}), project: 102 },
        },
        null,
      );
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(actualIsolation).toBe('serializable');
      expect((request.transaction as Transaction & { finished?: string }).finished).toBe('rollback');
      expect(await get(100)).toBeUndefined();
      expect((await get(3)).projectId).toBe(103);
    });
    it.each(['create', 'update'] as const)(
      'rolls back a planned %s after stored reference verification fails',
      async (kind) => {
        planning = tamper = true;
        const job = await execute(
          kind,
          {
            ...(kind === 'update' ? { filterByTk: 3 } : {}),
            values: { ...(kind === 'create' ? { id: 100 } : {}), project: 101 },
          },
          null,
        );
        expect(job.status).toBe(EXECUTION_STATUS.ERROR);
        expect((request.transaction as Transaction & { finished?: string }).finished).toBe('rollback');
        expect(await get(100)).toBeUndefined();
        expect((await get(3)).projectId).toBe(103);
      },
    );
    it('does not invoke planning to upgrade an insufficient caller transaction', async () => {
      planning = true;
      const job = await execute('update', { filterByTk: 3, values: { project: 101 } }, false);
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(planningCalls).toBe(0);
      expect(actualIsolation).toBe('read committed');
      expect((await get(3)).projectId).toBe(103);
    });
  });

  describe.runIf(supportsDeferredAssociationEvents)('existing many-to-many connections', () => {
    describe('shared connection filtered replacements', () => {
      beforeEach(async () => {
        planning = true;
        await joins.get('tags').model.create({ documentId: 3, projectId: 101 });
      });
      const params = (target = 101) => ({
        filterByTk: 3,
        filter: { tags: { id: target } },
        values: { name: 'Shared replacement', tags: [104] },
      });
      it('replaces the same shared connection used in its old selection condition', async () => {
        const job = await execute('update', params(), null);
        expect(job.status, job.result?.stack).toBe(EXECUTION_STATUS.RESOLVED);
        expect(actualIsolation).toBe('serializable');
        expect(await get(3)).toMatchObject({ name: 'Shared replacement', tenantId: 'B', projectId: 103 });
        expect(await linked(3)).toEqual([104]);
        expect((await projects.model.findByPk(104)).getDataValue('tenantId')).toBeNull();
      });
      it('cannot select a source by an unreadable connection target', async () => {
        await joins.get('tags').model.create({ documentId: 3, projectId: 102 });
        const job = await execute('update', params(102), null);
        expect(job.status).toBe(EXECUTION_STATUS.ERROR);
        expect(await get(3)).toMatchObject({ name: 'Second', tenantId: 'B', projectId: 103 });
        expect(await linked(3)).toEqual([101, 102]);
      });
      it('rolls back the stored filtered replacement if the execution adapter fails afterward', async () => {
        let observed: unknown;
        let notifications = 0;
        afterWrite = async () => {
          observed = {
            name: (await documents.model.findByPk(3, { transaction: request.transaction })).getDataValue('name'),
            links: (
              await joins.get('tags').model.findAll({ where: { documentId: 3 }, transaction: request.transaction })
            ).map((row) => row.getDataValue('projectId')),
          };
          request.transaction.afterCommit(() => {
            notifications++;
          });
          throw new Error('shared connection workflow rollback');
        };
        const job = await execute('update', params(), null);
        expect(job.status).toBe(EXECUTION_STATUS.ERROR);
        expect(observed).toEqual({ name: 'Shared replacement', links: [104] });
        expect(notifications).toBe(0);
        expect(await get(3)).toMatchObject({ name: 'Second', tenantId: 'B', projectId: 103 });
        expect(await linked(3)).toEqual([101]);
      });
    });
    it.each(['create', 'update'] as const)(
      'saves %s scalar fields, multiple links and a single reference atomically',
      async (kind) => {
        planning = true;
        const job = await execute(
          kind,
          {
            ...(kind === 'update' ? { filterByTk: 1 } : {}),
            values: {
              ...(kind === 'create' ? { id: 100 } : {}),
              name: 'Links',
              project: 103,
              tags: [101, 104],
              otherTags: [103],
            },
          },
          null,
        );
        expect(job.status, job.result?.stack).toBe(EXECUTION_STATUS.RESOLVED);
        const id = kind === 'create' ? 100 : 1;
        expect(await get(id)).toMatchObject({ tenantId: 'B', name: 'Links', projectId: 103 });
        expect(await linked(id)).toEqual([101, 104]);
        expect(await linked(id, 'otherTags')).toEqual([103]);
        expect(actualIsolation).toBe('serializable');
        const result = kind === 'create' ? job.result : job.result.data[0];
        expect(result.tags).toBeUndefined();
        expect((await projects.model.findByPk(104)).getDataValue('tenantId')).toBeNull();
      },
    );
  });

  describe.runIf(supportsDeferredAssociationEvents)('many-to-many write boundaries', () => {
    it.each([false, true])('handles link-only lifecycle without notifying unchanged links (%s)', async (unchanged) => {
      if (unchanged) await joins.get('tags').model.create({ documentId: 3, projectId: 101 });
      const observed: number[][] = [];
      const listener = async (_record, options) => {
        const rows = await joins
          .get('tags')
          .model.findAll({ where: { documentId: 3 }, transaction: options.transaction });
        observed.push(rows.map((row) => row.getDataValue('projectId')));
      };
      const event = `${documents.name}.afterUpdateWithAssociations`;
      app.db.on(event, listener);
      let job;
      try {
        job = await execute('update', { filterByTk: 3, values: { tags: [101] } });
      } finally {
        app.db.off(event, listener);
      }
      expect(job.status, job.result?.stack).toBe(EXECUTION_STATUS.RESOLVED);
      expect(job.result.length).toBe(unchanged ? 0 : 1);
      expect(observed).toEqual(unchanged ? [] : [[101]]);
      expect((await get(3)).name).toBe('Second');
      expect(await linked(3)).toEqual([101]);
    });
    it.each(['create', 'update'] as const)(
      'rolls back %s and its links when the flushed listener fails',
      async (kind) => {
        let notifications = 0;
        const event = `${documents.name}.${kind === 'create' ? 'afterCreateWithAssociations' : 'afterUpdateWithAssociations'}`;
        const listener = async (_record, options) => {
          options.transaction.afterCommit(() => {
            notifications++;
          });
          throw new Error('association listener failed');
        };
        app.db.on(event, listener);
        let job;
        try {
          job = await execute(kind, {
            ...(kind === 'update' ? { filterByTk: 3 } : {}),
            values: { ...(kind === 'create' ? { id: 100 } : {}), name: 'Must roll back', tags: [101] },
          });
        } finally {
          app.db.off(event, listener);
        }
        expect(job.status).toBe(EXECUTION_STATUS.ERROR);
        expect(job.result.message).toBe('association listener failed');
        expect(notifications).toBe(0);
        expect(await get(100)).toBeUndefined();
        expect((await get(3)).name).toBe('Second');
        expect(await linked(kind === 'create' ? 100 : 3)).toEqual([]);
      },
    );
    it.each([
      ['create', 'ownership'],
      ['create', 'connections'],
      ['update', 'ownership'],
      ['update', 'connections'],
    ] as const)('rechecks %s %s after flushed listeners', async (kind, tamper) => {
      const id = kind === 'create' ? 100 : 3;
      const event = `${documents.name}.${kind === 'create' ? 'afterCreateWithAssociations' : 'afterUpdateWithAssociations'}`;
      const listener = async (_record, options) => {
        if (tamper === 'ownership')
          await documents.model.update(
            { tenantId: 'C' },
            { where: { id }, transaction: options.transaction, hooks: false },
          );
        else
          await joins
            .get('tags')
            .model.destroy({ where: { documentId: id }, transaction: options.transaction, hooks: false });
      };
      app.db.on(event, listener);
      let job;
      try {
        job = await execute(kind, {
          ...(kind === 'update' ? { filterByTk: id } : {}),
          values: { ...(kind === 'create' ? { id } : {}), name: 'Must roll back', tags: [101] },
        });
      } finally {
        app.db.off(event, listener);
      }
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(await get(100)).toBeUndefined();
      expect(await get(3)).toMatchObject({ name: 'Second', tenantId: 'B' });
      expect(await linked(id)).toEqual([]);
    });
    it.each(['create', 'update'] as const)(
      'exposes completed connections to the %s association lifecycle event',
      async (kind) => {
        const event = `${documents.name}.${kind === 'create' ? 'afterCreateWithAssociations' : 'afterUpdateWithAssociations'}`;
        const observed: number[][] = [];
        const listener = async (record, options) => {
          const rows = await joins.get('tags').model.findAll({
            where: { documentId: record.getDataValue('id') },
            transaction: options.transaction,
            order: [['projectId', 'ASC']],
          });
          observed.push(rows.map((row) => row.getDataValue('projectId')));
        };
        app.db.on(event, listener);
        let job;
        try {
          job = await execute(kind, {
            ...(kind === 'update' ? { filterByTk: 1 } : {}),
            values: { ...(kind === 'create' ? { id: 100 } : {}), name: 'Lifecycle', tags: [101] },
          });
        } finally {
          app.db.off(event, listener);
        }
        expect(job.status, job.result?.stack).toBe(EXECUTION_STATUS.RESOLVED);
        expect(observed).toEqual([[101]]);
      },
    );
    it.each([103, 101])('checks create G against the persisted connections (%s)', async (key) => {
      await save(
        source,
        configFor({
          type: 'exists',
          path: 'tags',
          condition: {
            type: 'compare',
            operator: 'eq',
            left: { type: 'field', path: 'name' },
            right: { type: 'literal', value: 'Owned' },
          },
        }),
      );
      const job = await execute('create', { values: { id: 100, tags: [key] } });
      expect(job.status).toBe(key === 103 ? EXECUTION_STATUS.RESOLVED : EXECUTION_STATUS.ERROR);
      expect(!!(await get(100))).toBe(key === 103);
      expect(await linked(100)).toEqual(key === 103 ? [103] : []);
    });
    it('captures connection keys and the canonical actor before configuration awaits', async () => {
      const read = store.read.bind(store);
      vi.spyOn(store, 'read').mockImplementation(async (identity) => {
        const config = await read(identity);
        request.params.values.tags[0] = 102;
        request.context.state.currentTenantId = 'C';
        return config;
      });
      const job = await execute('create', { values: { id: 100, tags: [103] } });
      expect(job.status, job.result?.stack).toBe(EXECUTION_STATUS.RESOLVED);
      expect((await get(100)).tenantId).toBe('B');
      expect(await linked(100)).toEqual([103]);
    });
    it.each([102, 999])('rejects an unreadable added target %s without partial writes', async (key) => {
      const job = await execute('update', {
        filterByTk: 1,
        values: { name: 'No', project: 103, tags: [101], otherTags: [key] },
      });
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(await get()).toMatchObject({ name: 'First', projectId: 101 });
      expect(await linked()).toEqual([]);
    });
    it('requires G for every explicitly selected source', async () => {
      const job = await execute('update', { filterByTk: [1, 2], values: { tags: [101] } });
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(await linked()).toEqual([]);
      expect(await linked(2)).toEqual([]);
    });
    it('updates only G-matching sources under a root filter', async () => {
      const job = await execute('update', { filter: { id: { $in: [1, 2, 3] } }, values: { tags: [104] } });
      expect(job.status, job.result?.stack).toBe(EXECUTION_STATUS.RESOLVED);
      expect(job.result.data.map((row) => row.id)).toEqual([1, 3]);
      expect(await linked()).toEqual([104]);
      expect(await linked(2)).toEqual([]);
    });
    it.each([false, true])('preserves or clears hidden old connections (%s)', async (clear) => {
      await joins.get('tags').repository.create({ values: { documentId: 1, projectId: 102 } });
      const job = await execute('update', { filterByTk: 1, values: { tags: clear ? [] : [102] } });
      expect(job.status, job.result?.stack).toBe(EXECUTION_STATUS.RESOLVED);
      expect(job.result.length).toBe(clear ? 1 : 0);
      expect(await linked()).toEqual(clear ? [] : [102]);
      expect((await projects.model.findByPk(102)).getDataValue('tenantId')).toBe('C');
    });
    it.each([false, true])('claims a historical source only for a changed connection (%s)', async (changed) => {
      await save(
        source,
        configFor({
          type: 'any',
          children: [ownerCondition, { type: 'isNull', operand: { type: 'field', path: 'tenantId' } }],
        }),
      );
      await joins.get('tags').repository.create({ values: { documentId: 5, projectId: 103 } });
      const job = await execute('update', { filterByTk: [1, 5], values: { tags: changed ? [104] : [103] } });
      expect(job.status, job.result?.stack).toBe(EXECUTION_STATUS.RESOLVED);
      expect(job.result.data.map((row) => row.id)).toEqual(changed ? [1, 5] : [1]);
      expect((await get(5)).tenantId).toBe(changed ? 'B' : null);
      expect((await projects.model.findByPk(104)).getDataValue('tenantId')).toBeNull();
    });
    it.each([false, true])('preserves configured source individualHooks (%s)', async (individualHooks) => {
      failLater = true;
      const job = await execute('update', { filterByTk: 3, individualHooks, values: { name: 'Hooked', tags: [101] } });
      expect(job.status, job.result?.stack).toBe(individualHooks ? EXECUTION_STATUS.ERROR : EXECUTION_STATUS.RESOLVED);
      expect((await get(3)).name).toBe(individualHooks ? 'Second' : 'Hooked');
      expect(await linked(3)).toEqual(individualHooks ? [] : [101]);
    });
    it('rolls back every field and notification when a later join hook fails', async () => {
      let notified = false;
      joins.get('otherTags').model.addHook('afterBulkCreate', 'workflowLinkTest', async (_rows, options) => {
        options.transaction.afterCommit(() => {
          notified = true;
        });
        throw new Error('later join failed');
      });
      const job = await execute('update', {
        filterByTk: 1,
        values: { name: 'No', project: 103, tags: [101], otherTags: [104] },
      });
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(job.result.message).toBe('later join failed');
      expect(await get()).toMatchObject({ name: 'First', projectId: 101 });
      expect(await linked()).toEqual([]);
      expect(await linked(1, 'otherTags')).toEqual([]);
      expect(notified).toBe(false);
    });
    it('rejects a join hook replacing an authorized target key', async () => {
      joins.get('tags').model.addHook('afterBulkCreate', 'workflowLinkTest', async (_rows, options) => {
        await joins
          .get('tags')
          .model.update(
            { projectId: 102 },
            { where: { documentId: 1 }, transaction: options.transaction, hooks: false },
          );
      });
      const job = await execute('update', { filterByTk: 1, values: { tags: [101] } });
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(await linked()).toEqual([]);
    });
    it.each(['joinIdentity', 'relation', 'column'] as const)('rejects %s drift during preparation', async (part) => {
      const join = joins.get('tags');
      const stable = joinIdentities.get(join);
      const key = stable.collectionKey;
      const relation = documents.model.associations.tags;
      const column = join.model.rawAttributes.projectId.field;
      const read = store.read.bind(store);
      vi.spyOn(store, 'read').mockImplementation(async (identity) => {
        const config = await read(identity);
        if (part === 'joinIdentity') stable.collectionKey = 'replacement';
        else if (part === 'relation') documents.model.associations.tags = Object.create(relation);
        else join.model.rawAttributes.projectId.field = 'replacement_project';
        return config;
      });
      let job;
      try {
        job = await execute('create', { values: { id: 100, tags: [101] } });
      } finally {
        stable.collectionKey = key;
        documents.model.associations.tags = relation;
        join.model.rawAttributes.projectId.field = column;
      }
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(await get(100)).toBeUndefined();
    });
    it.each([
      ['null', null],
      ['scalar', 101],
      ['nested', [{ id: 101 }]],
      ['placeholder', ['_']],
      ['oversized', Array.from({ length: 1001 }, () => 101)],
    ])('rejects %s link values', async (_name, tags) => {
      const job = await execute('update', { filterByTk: 1, values: { tags } });
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(await linked()).toEqual([]);
    });
    it.each(['prototype', 'sparse', 'symbol'] as const)('rejects an original %s array before copying', async (part) => {
      transformInput = (input) => {
        const tags = input.params.values.tags;
        if (part === 'prototype') Object.setPrototypeOf(tags, Object.create(Array.prototype));
        else if (part === 'sparse') delete tags[0];
        else tags[Symbol('extra')] = true;
      };
      const job = await execute('update', { filterByTk: 1, values: { tags: [101] } });
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(await linked()).toEqual([]);
    });
    it('deduplicates target IDs while preserving zero', async () => {
      await projects.model.create({ id: 0, name: 'Zero', tenantId: 'B' });
      const job = await execute('update', { filterByTk: 1, values: { tags: [0, 101, '0101'] } });
      expect(job.status, job.result?.stack).toBe(EXECUTION_STATUS.RESOLVED);
      expect(await linked()).toEqual([0, 101]);
    });
    it('rejects a through table containing business fields', async () => {
      const join = joins.get('tags');
      join.setField('note', { type: 'string' });
      let job;
      try {
        job = await execute('update', { filterByTk: 1, values: { tags: [101] } });
      } finally {
        join.removeField('note');
      }
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(await linked()).toEqual([]);
    });
    it('rejects independently controlled through records', async () => {
      const join = joins.get('tags');
      const read = store.read.bind(store);
      const config = configFor({ type: 'all', children: [] });
      config.ownership.enabled = false;
      vi.spyOn(store, 'read').mockImplementation((identity) =>
        identity.collectionName === join.name ? Promise.resolve(config) : read(identity),
      );
      const job = await execute('update', { filterByTk: 1, values: { tags: [101] } });
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(await linked()).toEqual([]);
    });
  });

  it.each(['create', 'update'] as const)(
    'writes %s references under the actual configured operation without manual ACL',
    async (kind) => {
      const job = await execute(kind, {
        ...(kind === 'update' ? { filterByTk: 1 } : {}),
        values: { ...(kind === 'create' ? { id: 100 } : {}), name: 'Edited', project: 103, alternative: 104 },
      });
      expect(job.status, job.result?.stack).toBe(EXECUTION_STATUS.RESOLVED);
      expect(await get(kind === 'create' ? 100 : 1)).toMatchObject({
        name: 'Edited',
        projectId: 103,
        alternativeId: 104,
        tenantId: 'B',
      });
      const row = kind === 'create' ? job.result : job.result.data[0];
      expect(row).toMatchObject({ projectId: 103, alternativeId: 104 });
      expect(row.project).toBeUndefined();
      expect((await projects.model.findByPk(104)).getDataValue('tenantId')).toBeNull();
    },
  );
  it.each(['create', 'update'] as const)('allows a visibility-only target on %s', async (kind) => {
    const job = await execute(kind, {
      ...(kind === 'update' ? { filterByTk: 3 } : {}),
      values: { ...(kind === 'create' ? { id: 100 } : {}), project: 101 },
    });
    expect(job.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect((await get(kind === 'create' ? 100 : 3)).projectId).toBe(101);
  });
  it.each(['create', 'update'] as const)('supports an existing same-table reference on %s', async (kind) => {
    const job = await execute(kind, {
      ...(kind === 'update' ? { filterByTk: 3 } : {}),
      values: { ...(kind === 'create' ? { id: 100 } : {}), parent: 1 },
    });
    expect(job.status, job.result?.stack).toBe(EXECUTION_STATUS.RESOLVED);
    expect((await get(kind === 'create' ? 100 : 3)).parentId).toBe(1);
  });
  it.each([102, 999])('rejects hidden or missing new reference %s atomically', async (key) => {
    const job = await execute('update', { filterByTk: 1, values: { name: 'No', project: 103, alternative: key } });
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect(await get()).toMatchObject({ name: 'First', projectId: 101, alternativeId: null });
  });
  it('requires source G even when the target is readable', async () => {
    const job = await execute('update', { filterByTk: [1, 2], values: { project: 103 } });
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect((await get()).projectId).toBe(101);
  });
  it('updates references only for root conditions matching G', async () => {
    const job = await execute('update', { filter: { id: { $in: [1, 2, 3] } }, values: { project: 104 } });
    expect(job.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result.length).toBe(2);
    expect((await get(2)).projectId).toBe(102);
  });
  it('preserves an unchanged hidden reference and permits its ordinary source edit', async () => {
    await documents.model.update({ projectId: 102 }, { where: { id: 1 } });
    const job = await execute('update', { filterByTk: 1, values: { name: 'Edited', project: 102 } });
    expect(job.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(await get()).toMatchObject({ name: 'Edited', projectId: 102 });
  });
  it('does not write when an unchanged reference is the entire patch', async () => {
    const job = await execute('update', { filterByTk: 1, values: { project: 101 } });
    expect(job).toEqual({ status: EXECUTION_STATUS.RESOLVED, result: { length: 0, data: [] } });
  });
  it('clears a hidden reference without requiring new target access', async () => {
    await documents.model.update({ projectId: 102 }, { where: { id: 1 } });
    const job = await execute('update', { filterByTk: 1, values: { project: null } });
    expect(job.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect((await get()).projectId).toBeNull();
  });
  it('claims an editable legacy source while merely referencing a legacy target', async () => {
    await save(
      source,
      configFor({
        type: 'any',
        children: [ownerCondition, { type: 'isNull', operand: { type: 'field', path: 'tenantId' } }],
      }),
    );
    const job = await execute('update', { filterByTk: 5, values: { project: 104 } });
    expect(job.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(await get(5)).toMatchObject({ tenantId: 'B', projectId: 104 });
    expect((await projects.model.findByPk(104)).getDataValue('tenantId')).toBeNull();
  });
  it('does not claim an unchanged legacy row in a mixed reference batch', async () => {
    await save(
      source,
      configFor({
        type: 'any',
        children: [ownerCondition, { type: 'isNull', operand: { type: 'field', path: 'tenantId' } }],
      }),
    );
    await documents.model.update({ projectId: 103 }, { where: { id: 5 } });
    const job = await execute('update', { filterByTk: [1, 5], values: { project: 103 } });
    expect(job.status, job.result?.stack).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result.length).toBe(1);
    expect(job.result.data.map((row) => row.id)).toEqual([1]);
    expect(await get(1)).toMatchObject({ tenantId: 'B', projectId: 103 });
    expect(await get(5)).toMatchObject({ tenantId: null, projectId: 103 });
  });
  it('claims a legacy row when scalar fields change despite an unchanged reference', async () => {
    await save(
      source,
      configFor({
        type: 'any',
        children: [ownerCondition, { type: 'isNull', operand: { type: 'field', path: 'tenantId' } }],
      }),
    );
    await documents.model.update({ projectId: 103 }, { where: { id: 5 } });
    const job = await execute('update', { filterByTk: [1, 5], values: { name: 'Edited', project: 103 } });
    expect(job.status, job.result?.stack).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result.length).toBe(2);
    expect(await get(5)).toMatchObject({ name: 'Edited', tenantId: 'B', projectId: 103 });
  });
  it('checks G for an unchanged row before omitting it from a mixed reference batch', async () => {
    const job = await execute('update', { filterByTk: [2, 3], values: { project: 102 } });
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect(await get(2)).toMatchObject({ tenantId: 'C', projectId: 102 });
    expect(await get(3)).toMatchObject({ tenantId: 'B', projectId: 103 });
  });
  it.each(['create', 'update'] as const)('rejects insufficient inherited isolation for %s references', async (kind) => {
    const job = await execute(
      kind,
      { ...(kind === 'update' ? { filterByTk: 1 } : {}), values: { project: 103 } },
      false,
    );
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.result.message).toMatch(/isolation|serializable/i);
  });
  it('rolls back earlier source writes if a later row fails', async () => {
    failLater = true;
    const job = await execute('update', { values: { name: 'No partial commit', project: 104 } });
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.result.message).toBe('later reference update failed');
    expect((await get()).projectId).toBe(101);
  });
  it.each(['create', 'update'] as const)('rejects a hook changing the authorized %s reference', async (kind) => {
    tamper = true;
    const job = await execute(kind, {
      ...(kind === 'update' ? { filterByTk: 1 } : {}),
      values: { ...(kind === 'create' ? { id: 100 } : {}), project: 103 },
    });
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect(await get(100)).toBeUndefined();
    expect((await get()).projectId).toBe(101);
  });
  it.each(['create', 'update'] as const)('rejects a released preparation phase during %s', async (kind) => {
    release = true;
    const job = await execute(kind, {
      ...(kind === 'update' ? { filterByTk: 1 } : {}),
      values: { ...(kind === 'create' ? { id: 100 } : {}), project: 103 },
    });
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect((await get()).projectId).toBe(101);
  });
  it.each([{ project: { id: 103, name: 'No nested edit' } }, { projectId: 103 }, { project: 103, projectId: 102 }])(
    'rejects unsupported target writes %j',
    async (values) => {
      const job = await execute('update', { filterByTk: 1, values });
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect((await get()).projectId).toBe(101);
      expect((await projects.model.findByPk(103)).getDataValue('name')).toBe('Owned');
    },
  );
  it('captures reference keys and canonical actor before configuration loading', async () => {
    const read = store.read.bind(store);
    vi.spyOn(store, 'read').mockImplementation(async (identity) => {
      const config = await read(identity);
      request.params.values.project = 102;
      request.context.state.currentTenantId = 'C';
      return config;
    });
    const job = await execute('create', { values: { id: 100, project: 103 } });
    expect(job.status, job.result?.stack).toBe(EXECUTION_STATUS.RESOLVED);
    expect(await get(100)).toMatchObject({ projectId: 103, tenantId: 'B' });
  });
  it.each(['identity', 'association', 'interface', 'column'] as const)(
    'rejects %s changes during preparation',
    async (part) => {
      const read = store.read.bind(store);
      const key = target.collectionKey;
      const relation = documents.model.associations.alternative;
      const field = documents.getField('alternative');
      const kind = field.options.interface;
      const column = projects.model.rawAttributes.name.field;
      vi.spyOn(store, 'read').mockImplementation(async (identity) => {
        const config = await read(identity);
        if (part === 'identity') target.collectionKey = 'replacement';
        else if (part === 'association') documents.model.associations.alternative = Object.create(relation);
        else if (part === 'interface') field.options.interface = 'attachment';
        else projects.model.rawAttributes.name.field = 'replacement_name';
        return config;
      });
      let job;
      try {
        job = await execute('create', { values: { id: 100, project: 103, alternative: 104 } });
      } finally {
        target.collectionKey = key;
        documents.model.associations.alternative = relation;
        field.options.interface = kind;
        projects.model.rawAttributes.name.field = column;
      }
      expect(job.status).toBe(EXECUTION_STATUS.ERROR);
      expect(await get(100)).toBeUndefined();
    },
  );
  it.each([103, 101])('checks create G against the actual persisted reference: %s', async (key) => {
    await save(
      source,
      configFor({
        type: 'exists',
        path: 'project',
        condition: {
          type: 'compare',
          operator: 'eq',
          left: { type: 'field', path: 'name' },
          right: { type: 'literal', value: 'Owned' },
        },
      }),
    );
    const job = await execute('create', { values: { id: 100, project: key } });
    expect(job.status).toBe(key === 103 ? EXECUTION_STATUS.RESOLVED : EXECUTION_STATUS.ERROR);
    expect(!!(await get(100))).toBe(key === 103);
  });
  it('returns zero for a valid empty source selection without selecting its hidden target', async () => {
    const job = await execute('update', { filter: { id: 999 }, values: { project: 102 } });
    expect(job).toEqual({ status: EXECUTION_STATUS.RESOLVED, result: { length: 0, data: [] } });
  });
  it('does not treat a zero target key as clearing the reference', async () => {
    await projects.model.create({ id: 0, name: 'Owned zero', tenantId: 'B' });
    const job = await execute('update', { filterByTk: 1, values: { project: 0 } });
    expect(job.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect((await get()).projectId).toBe(0);
  });
  it('requires an explicit target configuration even when clearing a reference', async () => {
    const read = store.read.bind(store);
    vi.spyOn(store, 'read').mockImplementation((identity) =>
      identity.collectionName === projects.name ? Promise.resolve(null) : read(identity),
    );
    const job = await execute('update', { filterByTk: 1, values: { project: null } });
    expect(job.status).toBe(EXECUTION_STATUS.ERROR);
    expect((await get()).projectId).toBe(101);
  });
});

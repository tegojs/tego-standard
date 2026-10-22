import { createMockServer, type MockServer } from '@tachybase/test';
import { ACL, type Collection } from '@tego/server';

import { EXECUTION_STATUS } from '../../../../../module-workflow/src/server/constants';
import type WorkflowPlugin from '../../../../../module-workflow/src/server/Plugin';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessConfigHistory } from '../../access-control/config-history';
import {
  accessCollectionKey,
  AccessConfigStore,
  type AccessCollectionIdentity,
} from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import type { AccessConfig } from '../../access-control/types';
import type { AccessWorkflowQueryRequest } from '../../access-control/workflow-query-handler';
import { AccessWorkflowRootHandler } from '../../access-control/workflow-root-handler';
import { configFor, ownerCondition } from './fixtures';

/** Real node authority authorizes configured paths; every participating table still enforces its own G/V. */
describe('configured workflow association read authority', () => {
  let app: MockServer;
  let plugin: WorkflowPlugin;
  let adapter: AccessAclScopeAdapter;
  let store: AccessConfigStore;
  let queries: AccessQueryService;
  let handler: AccessWorkflowRootHandler;
  let lastRequest: AccessWorkflowQueryRequest;
  let workflow;
  const identities = new Map<string, AccessCollectionIdentity>();
  const identity = (collection: Collection) => identities.get(collection.name);
  const key = (collection: Collection) => accessCollectionKey(identity(collection)!);
  const names = [
    'relatedRegions',
    'relatedProjects',
    'relatedEntries',
    'relatedSummaries',
    'relatedLinks',
    'relatedDocs',
  ];

  beforeAll(async () => {
    app = await createMockServer({
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: [
        'error-handler',
        'collection',
        'user',
        [
          'workflow',
          {
            queryResolver: () => async (request) => {
              lastRequest = request;
              return handler.query(request);
            },
          },
        ],
      ],
    });
    plugin = app.pm.get('workflow') as WorkflowPlugin;
    const db = app.db;
    for (const name of names) {
      const stored = await db.getRepository('collections').create({
        context: {},
        values: {
          name,
          fields: [
            { name: 'name', type: 'string' },
            { name: 'tenantId', type: 'string' },
            ...(name === 'relatedProjects' ? [{ name: 'regionId', type: 'bigInt' }] : []),
            ...(name === 'relatedDocs' ? [{ name: 'projectId', type: 'bigInt' }] : []),
            ...(['relatedEntries', 'relatedSummaries'].includes(name) ? [{ name: 'documentId', type: 'bigInt' }] : []),
            ...(name === 'relatedLinks'
              ? [
                  { name: 'documentId', type: 'bigInt' },
                  { name: 'projectId', type: 'bigInt' },
                ]
              : []),
          ],
        },
      });
      identities.set(name, { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName: name });
    }
    db.getCollection('relatedProjects').setField('region', {
      type: 'belongsTo',
      target: 'relatedRegions',
      foreignKey: 'regionId',
    });
    const docs = db.getCollection('relatedDocs');
    docs.setField('project', { type: 'belongsTo', target: 'relatedProjects', foreignKey: 'projectId' });
    docs.setField('entries', { type: 'hasMany', target: 'relatedEntries', foreignKey: 'documentId' });
    docs.setField('summary', { type: 'hasOne', target: 'relatedSummaries', foreignKey: 'documentId' });
    docs.setField('projects', {
      type: 'belongsToMany',
      target: 'relatedProjects',
      through: 'relatedLinks',
      foreignKey: 'documentId',
      otherKey: 'projectId',
      throughUnique: false,
    });
    for (const name of names) await db.getCollection(name).model.sync();
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
    await tenants.model.bulkCreate(['B', 'C', 'H'].map((id) => ({ id, enabled: true })));
    await db.collection(accessConfigHistory).model.sync();
    store = new AccessConfigStore(db, (target) =>
      resolveModelMetadata(db.getCollection(target.collectionName), {
        resolveCollectionKey: key,
      }),
    );
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    queries = new AccessQueryService(db, adapter, key);
    handler = new AccessWorkflowRootHandler(db, adapter, queries, identity, (request) =>
      plugin.captureDataOperationAuthority(request),
    );
    await db.getCollection('relatedRegions').model.bulkCreate([
      { id: 201, name: 'Local region', tenantId: 'B' },
      { id: 202, name: 'Secret region', tenantId: 'C' },
    ]);
    await db.getCollection('relatedProjects').model.bulkCreate([
      { id: 101, name: 'Local project', tenantId: 'B', regionId: 201 },
      { id: 102, name: 'Visible', tenantId: 'H', regionId: 202 },
      { id: 103, name: 'Secret project', tenantId: 'C', regionId: 201 },
      { id: 104, name: 'Hidden link project', tenantId: 'B', regionId: 201 },
    ]);
    await docs.model.bulkCreate([
      { id: 1, name: 'Owned', tenantId: 'B', projectId: 101 },
      { id: 2, name: 'Visible', tenantId: 'H', projectId: 102 },
      { id: 3, name: 'Owned with hidden project', tenantId: 'B', projectId: 103 },
      { id: 4, name: 'Hidden', tenantId: 'C', projectId: 101 },
    ]);
    await db.getCollection('relatedEntries').model.bulkCreate([
      { id: 301, name: 'Local entry', tenantId: 'B', documentId: 1 },
      { id: 302, name: 'Visible', tenantId: 'H', documentId: 1 },
      { id: 303, name: 'Secret entry', tenantId: 'C', documentId: 1 },
      { id: 304, name: 'Local hidden document entry', tenantId: 'B', documentId: 4 },
    ]);
    await db.getCollection('relatedSummaries').model.bulkCreate([
      { id: 401, name: 'Local summary', tenantId: 'B', documentId: 1 },
      { id: 402, name: 'Secret summary', tenantId: 'C', documentId: 2 },
    ]);
    await db.getCollection('relatedLinks').model.bulkCreate([
      { id: 1, name: 'Owned', tenantId: 'B', documentId: 1, projectId: 101 },
      { id: 2, name: 'Visible', tenantId: 'H', documentId: 1, projectId: 102 },
      { id: 3, name: 'Owned', tenantId: 'B', documentId: 1, projectId: 103 },
      { id: 4, name: 'Hidden', tenantId: 'C', documentId: 1, projectId: 104 },
    ]);
  });
  beforeEach(async () => {
    for (const source of identities.values()) {
      const previous = await store.read(source);
      const config = configFor(ownerCondition);
      config.rules.push({
        ...configFor(
          {
            type: 'compare',
            operator: 'eq',
            left: { type: 'field', path: 'name' },
            right: { type: 'literal', value: 'Visible' },
          },
          'visibility',
        ).rules[0],
        id: 'visible',
      });
      await store.save(source, { ...config, revision: previous?.revision ?? 0 }, { userId: 28 });
    }
    workflow = await app.db.getRepository('workflows').create({
      values: {
        title: 'Configured association reads',
        type: 'collection',
        sync: true,
        enabled: true,
        config: { collection: 'relatedEvents', mode: 1 },
      },
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await workflow?.update({ enabled: false });
  });
  afterAll(async () => {
    await app?.destroy();
  });

  async function configure(name: string, config: AccessConfig) {
    const source = identities.get(name)!;
    await store.save(source, { ...config, revision: (await store.read(source))!.revision }, { userId: 28 });
  }
  async function run(state: object = { currentTenantId: 'B' }) {
    await plugin.trigger(workflow, { state: { currentTenantId: 'C', currentRole: 'root' } }, { context: { state } });
    const [execution] = await workflow.getExecutions({ order: [['id', 'DESC']] });
    const [job] = await execution.getJobs();
    return { execution, job };
  }
  async function execute(params = {}, state?: object) {
    await workflow.createNode({
      type: 'query',
      config: {
        collection: 'relatedDocs',
        multiple: true,
        params: { paginate: false, sort: [{ field: 'id' }], ...params },
      },
    });
    return run(state);
  }
  function released() {
    for (const source of identities.values())
      expect(() => adapter.configuration(lastRequest.context, source)).toThrow();
  }

  it('checks each configured single-value target independently and preserves readable roots', async () => {
    const { execution, job } = await execute({ fields: ['name', 'project.name', 'summary.name'] });
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result).toEqual([
      { name: 'Owned', project: { name: 'Local project' }, summary: { name: 'Local summary' } },
      { name: 'Visible', project: { name: 'Visible' }, summary: null },
      { name: 'Owned with hidden project', project: null, summary: null },
    ]);
    expect(execution.get('authContext')).toBeNull();
    released();
  });
  it('scopes one-to-many targets without admitting hidden roots or children', async () => {
    const { execution, job } = await execute({ fields: ['name', 'entries.name'] });
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result).toEqual([
      { name: 'Owned', entries: [{ name: 'Local entry' }, { name: 'Visible' }] },
      { name: 'Visible', entries: [] },
      { name: 'Owned with hidden project', entries: [] },
    ]);
  });
  it('requires G/V on both many-to-many target and through records', async () => {
    const { execution, job } = await execute({ fields: ['name', 'projects.name'] });
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result).toEqual([
      { name: 'Owned', projects: [{ name: 'Local project' }, { name: 'Visible' }] },
      { name: 'Visible', projects: [] },
      { name: 'Owned with hidden project', projects: [] },
    ]);
  });
  it('checks nested targets instead of borrowing the parent target scope', async () => {
    const { execution, job } = await execute({ fields: ['name', 'project.name', 'project.region.name'] });
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result).toEqual([
      { name: 'Owned', project: { name: 'Local project', region: { name: 'Local region' } } },
      { name: 'Visible', project: { name: 'Visible', region: null } },
      { name: 'Owned with hidden project', project: null },
    ]);
  });
  it.each([
    [{ project: { name: 'Local project' } }, ['Owned']],
    [{ project: { name: 'Secret project' } }, []],
    [{ entries: { name: 'Visible' } }, ['Owned']],
    [{ entries: { name: 'Secret entry' } }, []],
    [{ projects: { name: 'Visible' } }, ['Owned']],
    [{ projects: { name: 'Hidden link project' } }, []],
    [{ project: { region: { name: 'Secret region' } } }, []],
    [{ $not: { projects: { name: 'Secret project' } } }, ['Owned', 'Visible', 'Owned with hidden project']],
    [{ $or: [{ project: { name: 'Secret project' } }, { name: 'Visible' }] }, ['Visible']],
  ])('scopes configured association filters: %j', async (filter, expected) => {
    const { execution, job } = await execute({ fields: ['name'], filter });
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result).toEqual(expected.map((name) => ({ name })));
  });
  it.each(['relatedProjects', 'relatedLinks'])('rejects a missing configuration for %s', async (name) => {
    const read = store.read.bind(store);
    vi.spyOn(store, 'read').mockImplementation((source) =>
      source.collectionName === name ? Promise.resolve(null) : read(source),
    );
    const { execution, job } = await execute({ fields: ['name', 'projects.name'] });
    expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.result.message).toMatch(/config/i);
    released();
  });
  it.each(['relatedProjects', 'relatedLinks'])('does not grant access for empty rules on %s', async (name) => {
    await configure(name, {
      ...configFor({ type: 'constant', value: false }),
      ownership: { enabled: false },
      rules: [],
    });
    const { execution, job } = await execute({ fields: ['name', 'projects.name'], filter: { id: 1 } });
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result).toEqual([{ name: 'Owned', projects: [] }]);
  });
  it('supports identity-free automation only when all participating rules are explicitly shared', async () => {
    for (const name of ['relatedDocs', 'relatedProjects', 'relatedLinks'])
      await configure(name, configFor({ type: 'constant', value: true }, 'visibility'));
    const { execution, job } = await execute({ fields: ['name', 'projects.name'], filter: { id: 1 } }, {});
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result).toEqual([
      {
        name: 'Owned',
        projects: [
          { name: 'Local project' },
          { name: 'Visible' },
          { name: 'Secret project' },
          { name: 'Hidden link project' },
        ],
      },
    ]);
  });
  it('rejects missing target identity rather than borrowing event identity', async () => {
    await configure('relatedDocs', configFor({ type: 'constant', value: true }));
    const { execution, job } = await execute({ fields: ['name', 'project.name'] }, {});
    expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.result.message).toMatch(/context|tenant/i);
    released();
  });
  it('captures selected paths and identity before configuration awaits', async () => {
    const read = store.read.bind(store);
    vi.spyOn(store, 'read').mockImplementation(async (source) => {
      await Promise.resolve();
      (lastRequest.query as { fields: string[] }).fields.push('summary.name');
      (lastRequest.context as { state: { currentTenantId: string } }).state.currentTenantId = 'C';
      return read(source);
    });
    const { execution, job } = await execute({ fields: ['name', 'project.name'], filter: { id: 1 } });
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result).toEqual([{ name: 'Owned', project: { name: 'Local project' } }]);
  });
  it('only loads configurations for paths actually involved in this query', async () => {
    const read = vi.spyOn(store, 'read');
    const { execution, job } = await execute({ fields: ['name', 'project.name'], filter: { id: 1 } });
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result).toEqual([{ name: 'Owned', project: { name: 'Local project' } }]);
    expect(read.mock.calls.map(([source]) => source.collectionName).sort()).toEqual(['relatedDocs', 'relatedProjects']);
  });
  it('uses updated target rules for the next execution', async () => {
    const first = await execute({ fields: ['name', 'project.name'], filter: { id: 1 } });
    expect(first.execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(first.job.result).toEqual([{ name: 'Owned', project: { name: 'Local project' } }]);
    await configure('relatedProjects', configFor({ type: 'constant', value: false }));
    const next = await run();
    expect(next.execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(next.job.result).toEqual([{ name: 'Owned', project: null }]);
  });
  it('rejects target stable identity changes while loading configuration', async () => {
    const source = identities.get('relatedProjects')!;
    const read = store.read.bind(store);
    vi.spyOn(store, 'read').mockImplementation(async (target) => {
      const result = await read(target);
      if (target.collectionName === 'relatedProjects')
        identities.set(source.collectionName, { ...source, collectionKey: 'replacement' });
      return result;
    });
    try {
      const { execution, job } = await execute({ fields: ['name', 'project.name'] });
      expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
      expect(job.result.message).toMatch(/identity changed/i);
      released();
    } finally {
      identities.set(source.collectionName, source);
    }
  });
  it('rejects relationship changes while loading configuration', async () => {
    const relation = app.db.getCollection('relatedDocs').model.associations.project as { foreignKey?: string };
    const foreignKey = relation.foreignKey;
    const read = store.read.bind(store);
    vi.spyOn(store, 'read').mockImplementation(async (target) => {
      const result = await read(target);
      relation.foreignKey = 'replacementId';
      return result;
    });
    try {
      const { execution, job } = await execute({ fields: ['name', 'project.name'] });
      expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
      expect(job.result.message).toMatch(/metadata changed/i);
      released();
    } finally {
      relation.foreignKey = foreignKey;
    }
  });

  it('rejects a target identity from another data source before loading configuration', async () => {
    const source = identities.get('relatedProjects')!;
    identities.set(source.collectionName, { ...source, dataSourceKey: 'external' });
    const read = vi.spyOn(store, 'read');
    try {
      const { execution, job } = await execute({ fields: ['name', 'project.name'] });
      expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
      expect(job.result.message).toMatch(/cross data sources/i);
      expect(read).not.toHaveBeenCalled();
    } finally {
      identities.set(source.collectionName, source);
    }
  });

  it.each(['user.id', 'role.name'] as const)('requires target rule context %s independently', async (path) => {
    await configure(
      'relatedProjects',
      configFor({
        type: 'compare',
        operator: 'eq',
        left: { type: 'context', path },
        right: { type: 'literal', value: path === 'user.id' ? '28' : 'worker' },
      }),
    );
    const { execution, job } = await execute({ fields: ['name', 'project.name'] });
    expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.result.message).toMatch(/context/i);
    released();
  });

  it('preserves related configuration loading errors and releases every prepared table', async () => {
    const read = store.read.bind(store);
    vi.spyOn(store, 'read').mockImplementation((source) =>
      source.collectionName === 'relatedProjects'
        ? Promise.reject(new Error('related configuration unavailable'))
        : read(source),
    );
    const { execution, job } = await execute({ fields: ['name', 'project.name'] });
    expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.result.message).toBe('related configuration unavailable');
    released();
  });

  it('rejects through model substitution while loading configuration', async () => {
    const association = app.db.getCollection('relatedDocs').model.associations.projects;
    const relation = association as typeof association & {
      through: { model: Collection['model'] };
    };
    const model = relation.through.model;
    const read = store.read.bind(store);
    vi.spyOn(store, 'read').mockImplementation(async (source) => {
      const result = await read(source);
      relation.through.model = app.db.getCollection('relatedSummaries').model;
      return result;
    });
    try {
      const { execution, job } = await execute({ fields: ['name', 'projects.name'] });
      expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
      expect(job.result.message).toMatch(/metadata changed/i);
      released();
    } finally {
      relation.through.model = model;
    }
  });

  it('captures nested many-to-many paths and their independent through scope', async () => {
    const { execution, job } = await execute({
      fields: ['name', 'projects.name', 'projects.region.name'],
      filter: { id: 1 },
    });
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result).toEqual([
      {
        name: 'Owned',
        projects: [
          { name: 'Local project', region: { name: 'Local region' } },
          { name: 'Visible', region: null },
        ],
      },
    ]);
  });

  it('handles appends from the actual node protocol and filters hidden targets', async () => {
    const { execution, job } = await execute({ fields: ['name'], appends: ['project'], filter: { id: 3 } });
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.result).toEqual([{ name: 'Owned with hidden project', project: null }]);
  });
});

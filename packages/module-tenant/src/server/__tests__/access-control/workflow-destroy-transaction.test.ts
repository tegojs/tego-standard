import { Transaction, type Collection, type Database } from '@tego/server';

import {
  AccessWorkflowDestroyTransactionPlanner,
  workflowDestroyTransactionOptions,
} from '../../access-control/workflow-destroy-transaction';
import {
  AccessWorkflowWriteTransactionPlanner,
  workflowWriteTransactionOptions,
} from '../../access-control/workflow-write-transaction';
import { configStore, externalIdentity, initialConfig, mainIdentity, seedConfigStore } from './config-database';
import { sqliteDatabase } from './database';
import { configFor, participantCondition } from './fixtures';

describe.each([
  ['destroy', AccessWorkflowDestroyTransactionPlanner, workflowDestroyTransactionOptions],
  ['write', AccessWorkflowWriteTransactionPlanner, workflowWriteTransactionOptions],
] as const)('current-config workflow %s transaction planning', (_name, Planner, optionsFor) => {
  let db: Database;
  let collection: Collection;
  let store: ReturnType<typeof configStore>;
  let planner: AccessWorkflowDestroyTransactionPlanner;
  let currentIdentity: typeof mainIdentity;
  const target = () => ({ dataSourceName: 'main', collectionName: 'documents', collection });

  beforeEach(async () => {
    db = sqliteDatabase();
    await seedConfigStore(db);
    collection = db.collection({
      name: 'documents',
      fields: [
        { name: 'name', type: 'string' },
        { name: 'tenantId', type: 'string' },
        { name: 'amount', type: 'double' },
      ],
    });
    await collection.model.sync();
    await collection.model.create({ id: 1, tenantId: 'B', name: 'Owned', amount: 10 });
    store = configStore(db);
    await store.save(mainIdentity, initialConfig(), { userId: 28 });
    currentIdentity = { ...mainIdentity };
    planner = new Planner(db, store, () => currentIdentity);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close();
  });

  it('selects a write-locking SQLite transaction without deleting or preparing an authorization phase', async () => {
    expect(await planner.plan(target())).toEqual({ type: Transaction.TYPES.IMMEDIATE });
    expect(await collection.model.count()).toBe(1);
  });
  it('reads current configuration again rather than caching the earlier transaction requirement', async () => {
    expect(await planner.plan(target())).toEqual({ type: Transaction.TYPES.IMMEDIATE });
    const original = (await store.read(mainIdentity))!;
    await store.save(mainIdentity, { ...configFor(participantCondition), revision: original.revision }, { userId: 28 });
    await expect(planner.plan(target())).rejects.toThrow(/PostgreSQL/i);
    expect(await collection.model.count()).toBe(1);
  });
  it('does not impose serializable isolation for visibility-only relationship rules', async () => {
    const original = (await store.read(mainIdentity))!;
    await store.save(
      mainIdentity,
      { ...configFor(participantCondition, 'visibility'), revision: original.revision },
      { userId: 28 },
    );
    expect(await planner.plan(target())).toEqual({ type: Transaction.TYPES.IMMEDIATE });
  });
  it('does not authorize deletion when rules are empty', async () => {
    const original = (await store.read(mainIdentity))!;
    await store.save(mainIdentity, { ...original, rules: [] }, { userId: 28 });
    expect(await planner.plan(target())).toEqual({ type: Transaction.TYPES.IMMEDIATE });
    expect(await collection.model.count()).toBe(1);
  });
  it('rejects missing configuration instead of silently selecting default transaction settings', async () => {
    vi.spyOn(store, 'read').mockResolvedValue(null);
    await expect(planner.plan(target())).rejects.toThrow(/config/i);
    expect(await collection.model.count()).toBe(1);
  });
  it('preserves configuration read errors', async () => {
    const error = new Error('primary policy database unavailable');
    vi.spyOn(store, 'read').mockRejectedValue(error);
    await expect(planner.plan(target())).rejects.toBe(error);
  });
  it.each([{ dataSourceName: 'external' }, { collectionName: 'missing' }, { collection: {} }])(
    'rejects mismatched target %j before reading configuration',
    async (patch) => {
      const read = vi.spyOn(store, 'read');
      await expect(planner.plan({ ...target(), ...patch })).rejects.toThrow();
      expect(read).not.toHaveBeenCalled();
    },
  );
  it('captures stable identity before configuration loading can suspend', async () => {
    const read = store.read.bind(store);
    vi.spyOn(store, 'read').mockImplementation(async (source) => {
      const config = await read(source);
      currentIdentity.collectionKey = 'recreated-table';
      return config;
    });
    await expect(planner.plan(target())).rejects.toThrow(/identity|changed/i);
  });
  it('captures model metadata before configuration loading can suspend', async () => {
    const field = collection.model.rawAttributes.name;
    const column = field.field;
    const read = store.read.bind(store);
    vi.spyOn(store, 'read').mockImplementation(async (source) => {
      const config = await read(source);
      field.field = 'replacement_name';
      return config;
    });
    try {
      await expect(planner.plan(target())).rejects.toThrow(/metadata changed/i);
    } finally {
      field.field = column;
    }
  });

  it('keeps PostgreSQL root-only options unchanged and selects serializable isolation for relational G', () => {
    expect(optionsFor('postgres', initialConfig(), collection)).toEqual({});
    expect(optionsFor('postgres', configFor(participantCondition), collection)).toEqual({
      isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE,
    });
    expect(optionsFor('postgres', configFor(participantCondition, 'visibility'), collection)).toEqual({});
    const disabled = configFor(participantCondition);
    disabled.rules[0].enabled = false;
    expect(optionsFor('postgres', disabled, collection)).toEqual({});
  });
  it('does not choose options for unsupported write dialects', () => {
    expect(() => optionsFor('mysql', initialConfig(), collection)).toThrow(/dialect/i);
  });

  it('requires serializable PostgreSQL planning for a relationship selection filter', async () => {
    collection.setField('parent', { type: 'belongsTo', target: 'documents', foreignKey: 'parentId' });
    vi.spyOn(db.sequelize, 'getDialect').mockReturnValue('postgres');
    expect(await planner.plan({ ...target(), filter: { parent: { name: 'Owned' } } })).toEqual({
      isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE,
    });
  });

  it('rejects relationship selection on SQLite instead of opening an inadequate transaction', async () => {
    collection.setField('parent', { type: 'belongsTo', target: 'documents', foreignKey: 'parentId' });
    await expect(planner.plan({ ...target(), filter: { 'parent.name': 'Owned' } })).rejects.toThrow(/PostgreSQL/i);
  });

  it('keeps scalar selection filters on the original transaction plan', async () => {
    collection.setField('parent', { type: 'belongsTo', target: 'documents', foreignKey: 'parentId' });
    expect(await planner.plan({ ...target(), filter: { name: { $eq: 'Owned' } } })).toEqual({
      type: Transaction.TYPES.IMMEDIATE,
    });
  });

  it('captures the relationship filter before configuration loading suspends', async () => {
    collection.setField('parent', { type: 'belongsTo', target: 'documents', foreignKey: 'parentId' });
    vi.spyOn(db.sequelize, 'getDialect').mockReturnValue('postgres');
    const filter: { parent?: { name: string } } = { parent: { name: 'Owned' } };
    const read = store.read.bind(store);
    vi.spyOn(store, 'read').mockImplementation(async (source) => {
      const config = await read(source);
      delete filter.parent;
      return config;
    });
    expect(await planner.plan({ ...target(), filter })).toEqual({
      isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE,
    });
  });

  it('captures the selection before the identity resolver can mutate caller input', async () => {
    collection.setField('parent', { type: 'belongsTo', target: 'documents', foreignKey: 'parentId' });
    vi.spyOn(db.sequelize, 'getDialect').mockReturnValue('postgres');
    const filter: { parent?: { name: string } } = { parent: { name: 'Owned' } };
    const mutatingPlanner = new Planner(db, store, () => {
      delete filter.parent;
      return currentIdentity;
    });
    expect(await mutatingPlanner.plan({ ...target(), filter })).toEqual({
      isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE,
    });
  });

  it('rejects selection relationship metadata changes during policy loading', async () => {
    collection.setField('parent', { type: 'belongsTo', target: 'documents', foreignKey: 'parentId' });
    const relation = collection.model.associations.parent;
    const read = store.read.bind(store);
    vi.spyOn(store, 'read').mockImplementation(async (source) => {
      const config = await read(source);
      collection.model.associations.parent = Object.create(relation);
      return config;
    });
    await expect(planner.plan({ ...target(), filter: { parent: { name: 'Owned' } } })).rejects.toThrow(
      /metadata changed/i,
    );
  });

  it('rejects selection filter accessors without evaluating them or reading policy', async () => {
    let accessed = false;
    const filter = Object.defineProperty({}, 'name', {
      enumerable: true,
      get() {
        accessed = true;
        return 'Owned';
      },
    });
    const read = vi.spyOn(store, 'read');
    await expect(planner.plan({ ...target(), filter })).rejects.toThrow(/accessor/i);
    expect(accessed).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  if (_name === 'write') {
    it('requires PostgreSQL when the actual written field is an association', async () => {
      collection.setField('parent', { type: 'belongsTo', target: 'documents', foreignKey: 'parentId' });
      await expect(planner.plan({ ...target(), valueFields: ['parent'] })).rejects.toThrow(/PostgreSQL/i);
    });
    it('keeps ordinary fields on a collection with associations on the original plan', async () => {
      collection.setField('parent', { type: 'belongsTo', target: 'documents', foreignKey: 'parentId' });
      expect(await planner.plan({ ...target(), valueFields: ['name'] })).toEqual({
        type: Transaction.TYPES.IMMEDIATE,
      });
    });
    it('selects serializable PostgreSQL options only for a write using relationships', () => {
      expect(workflowWriteTransactionOptions('postgres', initialConfig(), collection, true)).toEqual({
        isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE,
      });
      expect(workflowWriteTransactionOptions('postgres', initialConfig(), collection, false)).toEqual({});
    });
    it.each([
      'parent',
      [undefined],
      ['parent', 'parent'],
      Object.assign([], { length: 1 }),
      { 0: 'parent', length: 1 },
    ])('rejects invalid field-name metadata %j before reading configuration', async (valueFields) => {
      const read = vi.spyOn(store, 'read');
      await expect(planner.plan({ ...target(), valueFields } as any)).rejects.toThrow(/field|list/i);
      expect(read).not.toHaveBeenCalled();
    });
    it('does not evaluate field-name accessors', async () => {
      let accessed = false;
      const fields = Object.defineProperty(['parent'], '0', {
        get() {
          accessed = true;
          return 'parent';
        },
      });
      await expect(planner.plan({ ...target(), valueFields: fields })).rejects.toThrow(/accessors/i);
      expect(accessed).toBe(false);
    });
    it('rejects relation metadata changes while loading policy', async () => {
      collection.setField('parent', { type: 'belongsTo', target: 'documents', foreignKey: 'parentId' });
      const relation = collection.model.associations.parent;
      const read = store.read.bind(store);
      vi.spyOn(store, 'read').mockImplementation(async (source) => {
        const config = await read(source);
        collection.model.associations.parent = Object.create(relation);
        return config;
      });
      await expect(planner.plan({ ...target(), valueFields: ['parent'] })).rejects.toThrow(/metadata changed/i);
    });
  }

  it('loads external target configuration from the primary store while planning the external database', async () => {
    const external = sqliteDatabase();
    try {
      const documents = external.collection({ name: 'documents', fields: [{ name: 'tenantId', type: 'string' }] });
      await external.sync();
      await store.save(externalIdentity, initialConfig(), { userId: 28 });
      const externalPlanner = new Planner(external, store, () => externalIdentity);
      expect(
        await externalPlanner.plan({ dataSourceName: 'external', collectionName: 'documents', collection: documents }),
      ).toEqual({ type: Transaction.TYPES.IMMEDIATE });
      expect(await collection.model.count()).toBe(1);
    } finally {
      await external.close();
    }
  });

  it('does not evaluate target accessors or read configuration for an invalid descriptor', async () => {
    const getter = vi.fn(() => collection);
    const read = vi.spyOn(store, 'read');
    const request = Object.defineProperty({ dataSourceName: 'main', collectionName: 'documents' }, 'collection', {
      get: getter,
    });
    await expect(planner.plan(request as ReturnType<typeof target>)).rejects.toThrow(/descriptor/i);
    expect(getter).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MockServer } from '@tachybase/test';
import { Database } from '@tego/server';

import { Dumper } from '../dumper';
import { Restorer } from '../restorer';
import { humanFileSize } from '../utils';
import createApp, { backupBaseTestPlugins } from './index';

async function waitFor<T>(callback: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 3000) {
  const startedAt = Date.now();
  let lastValue: T | undefined;

  while (Date.now() - startedAt < timeoutMs) {
    const value = await callback();
    lastValue = value;
    if (predicate(value)) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const value = await callback();
  lastValue = value;
  if (predicate(value)) {
    return value;
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for predicate. Last value: ${JSON.stringify(lastValue)}`);
}

describe('dumper', () => {
  let app: MockServer;
  let db: Database;
  const pluginOverrides = new Map<string, string[]>();
  const reusableBaseAppTests = new Set([
    'should save dump meta to dump file',
    'should run dump task',
    'should get dumped collections by data types',
    'should dump collection table structure',
    'should get dumped collections with origin option',
    'should get custom collections group',
  ]);
  let reusableBaseApp: MockServer | undefined;
  let shouldDestroyApp = false;

  beforeEach(async (context: any) => {
    shouldDestroyApp = false;
    const taskName = context.task.name;

    const additionalPlugins = pluginOverrides.get(taskName) || [];
    if (additionalPlugins.length === 0 && reusableBaseAppTests.has(taskName)) {
      reusableBaseApp ??= await createApp({
        plugins: backupBaseTestPlugins,
      });
      app = reusableBaseApp;
      db = app.db;
      return;
    }

    if (reusableBaseApp) {
      await reusableBaseApp.destroy();
      reusableBaseApp = undefined;
    }

    app = await createApp({
      plugins: [...backupBaseTestPlugins, ...additionalPlugins],
    });
    db = app.db;
    shouldDestroyApp = true;
  });

  afterEach(async () => {
    if (shouldDestroyApp) {
      await app.destroy();
    }
  });

  afterAll(async () => {
    await reusableBaseApp?.destroy();
  });

  function itWithPlugins(name: string, plugins: string[], fn: () => Promise<void>) {
    pluginOverrides.set(name, plugins);
    it(name, fn);
  }

  function itPostgresOnly(name: string, fn: () => Promise<void>) {
    const testFn = process.env.DB_DIALECT === 'postgres' ? it : it.skip;
    testFn(name, fn);
  }

  it.skip('should restore from file', async () => {
    const file = '/home/chareice/Downloads/backup_20231121_100606_4495.nbdump';
    const restorer = new Restorer(app, {
      backUpFilePath: file,
    });

    await restorer.restore({
      groups: new Set(['meta', 'business']),
    });
  });

  it('should write sql content', async () => {
    const dumper = new Dumper(app);

    const result = await dumper.dump({
      groups: new Set(['required']),
    });

    const restorer = new Restorer(app, {
      backUpFilePath: result.filePath,
    });

    await restorer.restore({
      groups: new Set(['required']),
    });
  });

  it('should dump and restore date field', async () => {
    await db.getRepository('collections').create({
      values: {
        name: 'tests',
        fields: [
          {
            type: 'date',
            name: 'test_data',
          },
        ],
      },
      context: {},
    });

    await db.getRepository('tests').create({
      values: {
        date: new Date(),
      },
    });

    const dumper = new Dumper(app);

    const result = await dumper.dump({
      groups: new Set(['required', 'custom']),
    });

    const restorer = new Restorer(app, {
      backUpFilePath: result.filePath,
    });

    await restorer.restore({
      groups: new Set(['required', 'custom']),
    });

    const testCollection = app.db.getCollection('tests');
    const items = await testCollection.repository.find();
    expect(items.length).toBe(1);
  });

  it('should dump and restore uuid field', async () => {
    await db.getRepository('collections').create({
      values: {
        name: 'tests',
        fields: [
          {
            type: 'uuid',
            name: 'uuid_test',
          },
        ],
      },
      context: {},
    });

    await db.getRepository('tests').create({
      values: {},
    });

    const dumper = new Dumper(app);

    const result = await dumper.dump({
      groups: new Set(['required', 'custom']),
    });

    const restorer = new Restorer(app, {
      backUpFilePath: result.filePath,
    });

    await restorer.restore({
      groups: new Set(['required', 'custom']),
    });

    const testCollection = app.db.getCollection('tests');
    const items = await testCollection.repository.find();
    expect(items.length).toBe(1);
  });

  describe('id seq', () => {
    let allGroups;

    beforeEach(async () => {
      await db.getRepository('collections').create({
        values: {
          name: 'tests',
          fields: [
            {
              type: 'string',
              name: 'name',
            },
          ],
        },
        context: {},
      });

      const Test = db.getCollection('tests');

      for (let i = 0; i < 3; i++) {
        await Test.repository.create({
          values: {
            name: `test${i}`,
          },
        });
      }

      const dumper = new Dumper(app);

      const collections = await dumper.collectionsGroupByDataTypes();
      allGroups = Object.keys(collections);

      const result = await dumper.dump({
        groups: new Set(allGroups),
      });

      const restorer = new Restorer(app, {
        backUpFilePath: result.filePath,
      });

      await restorer.restore({
        groups: new Set(allGroups),
      });
    });

    it('should reset id seq after restore collection', async () => {
      const testCollection = app.db.getCollection('tests');

      await testCollection.repository.create({
        values: {
          name: 'test',
        },
      });
    });
  });

  itPostgresOnly('should restore parent collection', async () => {
    await db.getRepository('collections').create({
      values: {
        name: 'parent',
        fields: [
          {
            type: 'string',
            name: 'parentName',
          },
        ],
      },
      context: {},
    });

    await db.getRepository('collections').create({
      values: {
        name: 'child',
        inherits: ['parent'],
        fields: [
          {
            type: 'string',
            name: 'childName',
          },
        ],
      },
      context: {},
    });

    await db.getRepository('parent').create({
      values: {
        parentName: 'parentName',
      },
    });

    await db.getRepository('child').create({
      values: {
        childName: 'childName',
      },
    });

    expect(await app.db.getRepository('parent').count()).toEqual(2);

    const dumper = new Dumper(app);
    const result = await dumper.dump({
      groups: new Set(['required', 'custom']),
    });

    const restorer = new Restorer(app, {
      backUpFilePath: result.filePath,
    });

    await restorer.restore({
      groups: new Set(['required', 'custom']),
    });

    expect(await app.db.getRepository('parent').count()).toEqual(2);
  });

  itWithPlugins('should restore with audit logs', ['audit-logs'], async () => {
    await app.db.getRepository('collections').create({
      values: {
        name: 'tests',
        logging: true,
        fields: [
          {
            type: 'string',
            name: 'name',
          },
        ],
      },
      context: {},
    });

    const Post = app.db.getCollection('tests').model;
    const post = await Post.create({ name: '123456' });
    await post.update({ name: '223456' });
    await post.destroy();
    const auditLogs = await waitFor(
      () =>
        app.db.getCollection('auditLogs').repository.find({
          appends: ['changes'],
        }),
      (logs) => logs.length === 3,
    );

    expect(auditLogs.length).toBe(3);

    const dumper = new Dumper(app);
    const result = await dumper.dump({
      groups: new Set(['required', 'log']),
    });

    const restorer = new Restorer(app, {
      backUpFilePath: result.filePath,
    });

    await restorer.restore({
      groups: new Set(['required', 'log']),
    });

    const log = await app.db.getCollection('auditLogs').repository.findOne({
      filter: { type: 'update' },
      appends: ['changes'],
    });

    const changes = log.get('changes');
    expect(typeof changes[0].before).toBe('string');
  });

  itPostgresOnly('should handle inherited collection order', async () => {
    await db.getRepository('collections').create({
      values: {
        name: 'parent1',
        fields: [
          {
            type: 'string',
            name: 'parent1Name',
          },
        ],
      },
      context: {},
    });

    await db.getRepository('collections').create({
      values: {
        name: 'parent2',
        fields: [
          {
            type: 'string',
            name: 'parent2Name',
          },
        ],
      },
      context: {},
    });

    await db.getRepository('collections').create({
      values: {
        name: 'child1',
        inherits: ['parent1', 'parent2'],
        fields: [
          {
            type: 'string',
            name: 'child1Name',
          },
        ],
      },
      context: {},
    });

    await db.getRepository('parent1').create({
      values: {
        parent1Name: 'parent1Name',
      },
    });

    await db.getRepository('parent2').create({
      values: {
        parent2Name: 'parent2Name',
      },
    });

    await db.getRepository('child1').create({
      values: {
        child1Name: 'child1Name',
      },
    });

    const dumper = new Dumper(app);
    const result = await dumper.dump({
      groups: new Set(['required', 'custom']),
    });

    const restorer = new Restorer(app, {
      backUpFilePath: result.filePath,
    });

    const meta = await restorer.parseBackupFile();

    const businessCollections = meta.dumpableCollectionsGroupByGroup.custom;
    const child1 = businessCollections.find(({ name }) => name === 'child1');

    expect(child1.inherits).toEqual(['parent1', 'parent2']);

    await restorer.restore({
      groups: new Set(['required', 'custom']),
    });
  });

  it.skip('should list dumped files', async () => {
    const dumper = new Dumper(app);
    const list = await dumper.allBackUpFilePaths({
      includeInProgress: true,
      dir: path.join(__dirname, './fixtures/files'),
    });
    expect(list.length).toBe(2);
  });

  itWithPlugins('should dump and restore with sql collection', ['users'], async () => {
    const userCollection = db.getCollection('users');

    await db.getRepository('collections').create({
      values: {
        name: 'tests',
        sql: `select count(*) as count from ${userCollection.getTableNameWithSchemaAsString()}`,
        fields: [
          {
            type: 'integer',
            name: 'count',
          },
        ],
      },
      context: {},
    });

    const usersCount = await db.getRepository('users').count();
    const res = await db.getRepository('tests').findOne();
    expect(res.get('count')).toEqual(usersCount);

    const dumper = new Dumper(app);
    const result = await dumper.dump({
      groups: new Set(['required', 'custom']),
    });

    const restorer = new Restorer(app, {
      backUpFilePath: result.filePath,
    });

    await restorer.restore({
      groups: new Set(['required', 'custom']),
    });

    const res2 = await app.db.getRepository('tests').findOne();
    expect(res2.get('count')).toEqual(usersCount);
  });

  it('should dump with view that not exists', async () => {
    await db.getRepository('collections').create({
      values: {
        name: 'view_not_exists',
        view: true,
        schema: db.inDialect('postgres') ? 'public' : undefined,
        fields: [
          {
            type: 'string',
            name: 'name',
          },
        ],
      },
      context: {},
    });

    const dumper = new Dumper(app);
    const result = await dumper.dump({
      groups: new Set(['required', 'custom']),
    });

    const restorer = new Restorer(app, {
      backUpFilePath: result.filePath,
    });

    await restorer.restore({
      groups: new Set(['required', 'custom']),
    });
  });

  it('should dump and restore with view collection', async () => {
    await db.getRepository('collections').create({
      values: {
        name: 'tests',
        fields: [
          {
            type: 'string',
            name: 'name',
          },
        ],
      },
      context: {},
    });

    const testCollection = db.getCollection('tests');

    const viewName = 'test_view';

    const dropViewSQL = `DROP VIEW IF EXISTS ${viewName}`;
    await db.sequelize.query(dropViewSQL);

    const viewSQL = `CREATE VIEW ${viewName} as SELECT * FROM ${testCollection.quotedTableName()}`;

    await db.sequelize.query(viewSQL);

    await db.getRepository('collections').create({
      values: {
        name: viewName,
        view: true,
        schema: db.inDialect('postgres') ? 'public' : undefined,
        fields: [
          {
            type: 'string',
            name: 'name',
          },
        ],
      },
      context: {},
    });

    const dumper = new Dumper(app);
    const result = await dumper.dump({
      groups: new Set(['required', 'custom']),
    });

    const restorer = new Restorer(app, {
      backUpFilePath: result.filePath,
    });

    await restorer.restore({
      groups: new Set(['required', 'custom']),
    });
  });

  itWithPlugins('should dump & restore sequence data', ['sequence-field'], async () => {
    await db.getRepository('collections').create({
      values: {
        name: 'tests',
        fields: [
          {
            type: 'sequence',
            name: 'name',
            patterns: [
              {
                type: 'integer',
                options: { key: 1 },
              },
            ],
          },
        ],
      },
      context: {},
    });

    const Test = db.getCollection('tests');

    const sequenceCollection = db.getCollection('sequences');
    expect(await sequenceCollection.repository.count()).toBe(1);

    const dumper = new Dumper(app);
    const result = await dumper.dump({
      groups: new Set(['required', 'custom']),
    });

    const restorer = new Restorer(app, {
      backUpFilePath: result.filePath,
    });

    await restorer.restore({
      groups: new Set(['required', 'custom']),
    });

    expect(await app.db.getCollection('sequences').repository.count()).toBe(1);
  });

  itWithPlugins('should dump and restore map file', ['block-map'], async () => {
    const data = {
      polygon: [
        [114.081074, 22.563646],
        [114.147335, 22.559207],
        [114.134975, 22.531621],
        [114.09103, 22.520045],
        [114.033695, 22.575376],
        [114.025284, 22.55461],
        [114.033523, 22.533048],
      ],
      point: [114.048868, 22.554927],
      circle: [114.058996, 22.549695, 4171],
      lineString: [
        [114.047323, 22.534158],
        [114.120966, 22.544146],
      ],
    };

    const fields = [
      {
        type: 'point',
        name: 'point',
      },
      {
        type: 'polygon',
        name: 'polygon',
      },
      {
        type: 'circle',
        name: 'circle',
      },
      {
        type: 'lineString',
        name: 'lineString',
      },
    ];

    await app.db.getRepository('collections').create({
      values: {
        name: 'tests',
        fields,
      },
      context: {},
    });

    await app.db.getRepository('tests').create({
      values: {
        ...data,
      },
    });

    const dumper = new Dumper(app);
    const result = await dumper.dump({
      groups: new Set(['required', 'custom']),
    });

    const restorer = new Restorer(app, {
      backUpFilePath: result.filePath,
    });

    await restorer.restore({
      groups: new Set(['required', 'custom']),
    });

    const testCollection = app.db.getCollection('tests');
    const tableInfo = await app.db.sequelize.getQueryInterface().describeTable(testCollection.getTableNameWithSchema());

    expect(tableInfo.point).toBeDefined();
  });

  it('should dump collection meta', async () => {
    await db.getRepository('collections').create({
      values: {
        name: 'tests',
        fields: [
          {
            type: 'string',
            name: 'name',
          },
        ],
      },
      context: {},
    });

    await db.getRepository('tests').create({
      values: [
        {
          name: 'test1',
        },
        {
          name: 'test2',
        },
      ],
    });

    const dumper = new Dumper(app);
    await dumper.dumpCollection({
      name: 'tests',
    });

    const collectionDir = path.resolve(dumper.workDir, 'collections', 'tests');
    const metaFile = path.resolve(collectionDir, 'meta');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));

    expect(meta.name).toBe('tests');
    const autoIncrement = meta.autoIncrement;
    expect(autoIncrement).toBeDefined();
  });

  it('should save dump meta to dump file', async () => {
    const dumper = new Dumper(app);
    const result = await dumper.dump({
      groups: new Set(['required']),
    });

    const restorer = new Restorer(app, {
      backUpFilePath: result.filePath,
    });

    const meta = await restorer.parseBackupFile();
    expect(meta.dumpableCollectionsGroupByGroup.required).toBeTruthy();

    expect(meta.version).toBeDefined();
    expect(meta.dialect).toBeDefined();
  });

  it('should run dump task', async () => {
    const dumper = new Dumper(app);

    const taskId = dumper.startDumpTask({
      groups: new Set(['meta']),
    });

    expect(taskId).toBeDefined();

    const promise = Dumper.getTaskPromise(taskId);
    expect(promise).toBeDefined();

    await promise;
  });

  it('should wait for dump task completion', async () => {
    const dumper = new Dumper(app);

    const taskId = await dumper.runDumpTask({
      groups: new Set(['meta']),
    });

    expect(taskId).toBeDefined();
    expect(Dumper.getTaskPromise(taskId)).toBeUndefined();
    await expect(fsPromises.stat(dumper.backUpFilePath(taskId))).resolves.toBeDefined();
  });

  it('should get dumped collections by data types', async () => {
    const collectionName = 'dumped_data_types_collection';
    await app.db.getRepository('collections').create({
      values: {
        name: collectionName,
        fields: [
          {
            name: 'test_field1',
            type: 'string',
          },
        ],
      },
      context: {},
    });

    const dumper = new Dumper(app);
    const collections = await dumper.getCollectionsByDataTypes(new Set(['custom']));
    expect(collections.includes(collectionName)).toBeTruthy();
  });

  it('should dump collection table structure', async () => {
    const collectionName = 'dump_table_structure_collection';
    await app.db.getRepository('collections').create({
      values: {
        name: collectionName,
        fields: [
          {
            name: 'test_field1',
            type: 'string',
          },
        ],
      },
      context: {},
    });

    const dumper = new Dumper(app);
    await dumper.dumpCollection({
      name: collectionName,
    });

    const collectionDir = path.resolve(dumper.workDir, 'collections', collectionName);
    const metaFile = path.resolve(collectionDir, 'meta');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));

    const attributes = meta.attributes;
    expect(attributes).toBeDefined();
    expect(attributes.id.isCollectionField).toBeFalsy();
    expect(attributes.id.type).toBe('BIGINT');

    expect(attributes['test_field1'].isCollectionField).toBeTruthy();
    expect(attributes['test_field1'].type).toBe('string');
  });

  it('should get dumped collections with origin option', async () => {
    const dumper = new Dumper(app);
    const dumpableCollections = await dumper.dumpableCollections();
    const applicationPlugins = dumpableCollections.find(({ name }) => name === 'applicationPlugins');

    expect(applicationPlugins.origin).toBe('@tego/core');
  });

  it('should get custom collections group', async () => {
    const collectionName = 'custom_group_collection';
    await app.db.getRepository('collections').create({
      values: {
        name: collectionName,
        fields: [
          {
            name: 'test_field1',
            type: 'string',
          },
        ],
      },
      context: {},
    });

    const dumper = new Dumper(app);
    const dumpableCollections = await dumper.collectionsGroupByDataTypes();

    expect(dumpableCollections.custom).toBeDefined();
  });
});

describe('dumper utils', () => {
  it('should sort collections by inherits', async () => {
    const collections = [
      {
        name: 'parent1',
        inherits: [],
      },
      {
        name: 'parent2',
        inherits: [],
      },
      {
        name: 'child3',
        inherits: ['child1', 'child2'],
      },
      {
        name: 'child1',
        inherits: ['parent1', 'parent2'],
      },
      {
        name: 'child2',
        inherits: ['parent1'],
      },
    ];

    const sorted = Restorer.sortCollectionsByInherits(collections);

    expect(sorted[0].name).toBe('parent1');
    expect(sorted[1].name).toBe('parent2');
    expect(sorted[2].name).toBe('child1');
    expect(sorted[3].name).toBe('child2');
    expect(sorted[4].name).toBe('child3');
  });

  describe('get file status', function () {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'backup-status-'));
    });

    afterEach(async () => {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    });

    it('should get in progress status', async () => {
      const backupFilePath = path.join(tempDir, Dumper.generateFileName());
      await fsPromises.writeFile(`${backupFilePath}.lock`, 'lock', 'utf8');

      const status = await Dumper.getFileStatus(backupFilePath);
      expect(status.status).toEqual('in_progress');
    });

    it('should get ok status', async () => {
      const backupFilePath = path.join(tempDir, Dumper.generateFileName());
      await fsPromises.writeFile(backupFilePath, 'backup', 'utf8');

      const status = await Dumper.getFileStatus(backupFilePath);
      expect(status).toMatchObject({
        name: path.basename(backupFilePath),
        fileSize: humanFileSize('backup'.length),
        status: 'ok',
      });
      expect(status['inProgress']).toBeFalsy();
    });

    it('should throw error when file not exists', async () => {
      await expect(Dumper.getFileStatus(path.join(tempDir, 'not_exists_file'))).rejects.toThrowError();
    });
  });

  it('should create dump file name', async () => {
    expect(Dumper.generateFileName()).toMatch(/^backup_\d{8}_\d{6}_\d{4}\.tbdump$/);
  });
});

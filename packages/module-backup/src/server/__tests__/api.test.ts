import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import { MockServer } from '@tachybase/test';
import { DumpRulesGroupType } from '@tego/server';

import { Dumper } from '../dumper';
import createApp, { backupBaseTestPlugins, backupTestPlugins } from './index';

describe('backup files', () => {
  let app: MockServer;
  let dumper: Dumper;
  const backupFilesToClean = new Set<string>();

  async function setupApp(plugins = backupTestPlugins) {
    app = await createApp({ plugins });
    dumper = new Dumper(app);
  }

  function markBackupFileForCleanup(fileName: string) {
    backupFilesToClean.add(fileName);
  }

  async function cleanupBackupFiles() {
    for (const fileName of backupFilesToClean) {
      await fs.rm(dumper.backUpFilePath(fileName), { force: true });
      await fs.rm(dumper.lockFilePath(fileName), { force: true });
      await fs.rm(`${dumper.backUpFilePath(fileName)}.progress`, { force: true });
    }
    backupFilesToClean.clear();
  }

  async function teardownApp() {
    await cleanupBackupFiles();
    await app.destroy();
  }

  async function createBackup(groups: DumpRulesGroupType[]) {
    const dumpKey = dumper.startDumpTask({
      groups: new Set(groups),
    });

    await Dumper.getTaskPromise(dumpKey);
    markBackupFileForCleanup(dumpKey);

    return dumpKey;
  }

  describe('create action', () => {
    beforeEach(() => setupApp(backupBaseTestPlugins));
    afterEach(teardownApp);

    it('should create dump file', async () => {
      const createResponse = await app
        .agent()
        .resource('backupFiles')
        .create({
          dataTypes: ['meta', 'config', 'business'],
        });

      expect(createResponse.status).toBe(200);

      const dumpKey = createResponse.body.data.key;
      expect(dumpKey).toBeDefined();
      markBackupFileForCleanup(dumpKey);

      const promise = Dumper.getTaskPromise(dumpKey);

      await promise;
    });
  });

  describe('resource action', () => {
    beforeAll(() => setupApp(backupBaseTestPlugins));
    afterAll(async () => {
      await teardownApp();
    });

    afterEach(cleanupBackupFiles);

    it('should list backup file with in progress status', async () => {
      const fileName = Dumper.generateFileName();
      await dumper.writeLockFile(fileName);
      markBackupFileForCleanup(fileName);
      const listResponse = await app.agent().resource('backupFiles').list();

      expect(listResponse.status).toBe(200);

      const body = listResponse.body;

      const item = body.data.find((item: any) => item.name === fileName);
      expect(item).toBeDefined();
      expect(item.status).toEqual('in_progress');
    });

    it('should list backup file', async () => {
      await createBackup(['required']);
      const listResponse = await app.agent().resource('backupFiles').list();

      expect(listResponse.status).toBe(200);

      const body = listResponse.body;

      expect(body.meta.count).toBeDefined();
      expect(body.meta.totalPage).toBeDefined();
    });

    it('should get backup file', async () => {
      const dumpKey = await createBackup(['required']);
      const getResponse = await app.agent().resource('backupFiles').get({
        filterByTk: dumpKey,
      });

      expect(getResponse.status).toBe(200);

      expect(getResponse.body.data.name).toEqual(dumpKey);
    });

    it('should download backup file as attachment stream', async () => {
      const dumpKey = await createBackup(['required']);
      const filePath = dumper.backUpFilePath(dumpKey);
      const stats = await fs.stat(filePath);

      const downloadResponse = await app
        .agent()
        .get(`/backupFiles:download?filterByTk=${encodeURIComponent(dumpKey)}`)
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
          res.on('error', callback);
        });

      expect(downloadResponse.status).toBe(200);
      expect(downloadResponse.headers['content-type']).toContain('application/octet-stream');
      expect(downloadResponse.headers['x-accel-buffering']).toBe('no');
      expect(downloadResponse.headers['content-length']).toBe(String(stats.size));
      expect(downloadResponse.headers['content-disposition']).toContain(`attachment; filename="${dumpKey}"`);
      expect(downloadResponse.body).toBeInstanceOf(Buffer);
      expect(downloadResponse.body.length).toBe(stats.size);
    });

    it('should destroy dump file', async () => {
      const dumpKey = await createBackup(['required']);
      const destroyResponse = await app.agent().resource('backupFiles').destroy({
        filterByTk: dumpKey,
      });

      expect(destroyResponse.status).toBe(200);
      backupFilesToClean.delete(dumpKey);

      const getResponse = await app.agent().resource('backupFiles').get({
        filterByTk: dumpKey,
      });

      expect(getResponse.status).toBe(404);
    });
  });

  describe('restore action', () => {
    let dumpKey: string;

    beforeEach(() => setupApp());
    afterEach(teardownApp);

    beforeEach(async () => {
      dumpKey = await createBackup(['meta', 'config', 'business']);
    });

    it('should restore from file name', async () => {
      const restoreResponse = await app
        .agent()
        .resource('backupFiles')
        .restore({
          values: {
            filterByTk: dumpKey,
            dataTypes: ['meta', 'config', 'business'],
          },
        });

      expect(restoreResponse.status).toBe(200);
    });

    it('should restore from upload file', async () => {
      const filePath = dumper.backUpFilePath(dumpKey);
      const packageInfoResponse = await app.agent().post('/backupFiles:upload').attach('file', filePath);

      expect(packageInfoResponse.status).toBe(200);
      const data = packageInfoResponse.body.data;

      expect(data['key']).toBeTruthy();
      expect(data['meta']).toBeTruthy();

      const restoreResponse = await app
        .agent()
        .resource('backupFiles')
        .restore({
          values: {
            key: data['key'],
            dataTypes: ['meta', 'config', 'business'],
          },
        });

      expect(restoreResponse.status).toBe(200);
    });
  });

  describe('dumpable collections', () => {
    beforeEach(() => setupApp());
    afterEach(teardownApp);

    it('should get dumpable collections', async () => {
      await app.db.getCollection('collections').repository.create({
        values: {
          name: 'test',
          title: '测试',
          fields: [
            {
              name: 'title',
              type: 'string',
              title: '标题',
            },
          ],
        },
        context: {},
      });

      const response = await app.agent().get('/backupFiles:dumpableCollections');

      expect(response.status).toBe(200);

      const body = response.body;

      expect(body['required']).toBeTruthy();
      expect(body['third-party']).toBeTruthy();
      expect(body['custom']).toBeTruthy();

      const testCollectionInfo = body['custom'].find((item: any) => item.name === 'test');

      expect(testCollectionInfo).toMatchObject({
        name: 'test',
        title: '测试',
        group: 'custom',
        origin: '@tachybase/module-collection',
      });
    });
  });
});

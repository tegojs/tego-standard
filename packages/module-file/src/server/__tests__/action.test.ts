import { promises as fs } from 'node:fs';
import path from 'node:path';

import { getApp } from '.';
import { FILE_FIELD_NAME, STORAGE_TYPE_LOCAL } from '../constants';

const { LOCAL_STORAGE_BASE_URL, LOCAL_STORAGE_DEST = 'storage/uploads', APP_PORT = '3000' } = process.env;

const DEFAULT_LOCAL_BASE_URL = LOCAL_STORAGE_BASE_URL || `/storage/uploads`;
const textFilePath = path.resolve(__dirname, './files/text.txt');
const textFileExpectedContent = await fs.readFile(textFilePath, 'utf8');
const textFileExpectedSize = Buffer.byteLength(textFileExpectedContent);

describe('action', () => {
  let app;
  let agent;
  let db;
  let StorageRepo;
  let AttachmentRepo;

  async function removeAttachmentFiles() {
    const attachments = await AttachmentRepo.find({
      appends: ['storage'],
      paranoid: false,
    });

    for (const attachment of attachments) {
      const storage = attachment.get('storage');
      if (!storage) {
        continue;
      }

      const { documentRoot = path.join('storage', 'uploads') } = storage.options || {};
      const destPath = path.resolve(
        path.isAbsolute(documentRoot) ? documentRoot : path.join(process.env.TEGO_RUNTIME_HOME, documentRoot),
        storage.path,
      );
      await fs.unlink(path.join(destPath, attachment.filename)).catch(() => null);
    }
  }

  async function resetFileData() {
    await removeAttachmentFiles();
    await AttachmentRepo.destroy({
      truncate: true,
      force: true,
    });
  }

  beforeAll(async () => {
    app = await getApp({
      database: {},
    });
    agent = app.agent();
    db = app.db;

    AttachmentRepo = db.getCollection('attachments').repository;
    StorageRepo = db.getCollection('storages').repository;
    await StorageRepo.create({
      values: {
        name: 'local1',
        type: STORAGE_TYPE_LOCAL,
        baseUrl: DEFAULT_LOCAL_BASE_URL,
        rules: {
          size: 1024,
        },
        paranoid: true,
      },
    });
  });

  beforeEach(async () => {
    await resetFileData();
  });

  afterAll(async () => {
    await resetFileData();
    await app.destroy();
  });

  describe('create / upload', () => {
    describe('default storage', () => {
      it('upload file should be ok', async () => {
        const { body } = await agent.resource('attachments').create({
          [FILE_FIELD_NAME]: textFilePath,
        });

        const matcher = {
          title: 'text',
          extname: '.txt',
          path: '',
          size: textFileExpectedSize,
          mimetype: 'text/plain',
          meta: {},
          storageId: 1,
        };

        // 文件上传和解析是否正常
        expect(body.data).toMatchObject(matcher);
        // 文件的 url 是否正常生成
        expect(body.data.url).toBe(`${DEFAULT_LOCAL_BASE_URL}${body.data.path}/${body.data.filename}`);

        const Attachment = db.getModel('attachments');
        const attachment = await Attachment.findOne({
          where: { id: body.data.id },
          include: ['storage'],
        });
        // 文件的数据是否正常保存
        expect(attachment).toMatchObject(matcher);

        // 关联的存储引擎是否正确
        const storage = await attachment.getStorage();
        expect(storage).toMatchObject({
          type: 'local',
          options: { documentRoot: LOCAL_STORAGE_DEST },
          rules: {},
          path: '',
          baseUrl: DEFAULT_LOCAL_BASE_URL,
          default: true,
        });

        const { documentRoot = 'storage/uploads' } = storage.options || {};
        const destPath = path.resolve(
          path.isAbsolute(documentRoot) ? documentRoot : path.join(process.env.TEGO_RUNTIME_HOME, documentRoot),
          storage.path,
        );
        const file = await fs.readFile(`${destPath}/${attachment.filename}`);
        // 文件是否保存到指定路径
        expect(file.toString()).toBe(textFileExpectedContent);

        // 通过 url 是否能正确访问
        const url = attachment.url.replace(`http://localhost:${APP_PORT}`, '');
        const content = await agent.get(url);
        expect(content.text).toBe(textFileExpectedContent);
      });
    });

    describe('specific storage', () => {
      it('fail as 400 because file size greater than rules', async () => {
        const collectionName = 'customersSizeRule';
        db.collection({
          name: collectionName,
          fields: [
            {
              name: 'avatar',
              type: 'belongsTo',
              target: 'attachments',
              storage: 'local1',
            },
          ],
        });

        const response = await agent.resource('attachments').create({
          attachmentField: `${collectionName}.avatar`,
          file: path.resolve(__dirname, './files/image.jpg'),
        });
        expect(response.status).toBe(400);
      });

      it('fail as 400 because file mimetype does not match', async () => {
        const textStorage = await StorageRepo.create({
          values: {
            name: 'localTextOnly',
            type: STORAGE_TYPE_LOCAL,
            baseUrl: DEFAULT_LOCAL_BASE_URL,
            rules: {
              mimetype: ['text/*'],
            },
          },
        });

        const collectionName = 'customersMimeRule';
        db.collection({
          name: collectionName,
          fields: [
            {
              name: 'avatar',
              type: 'belongsTo',
              target: 'attachments',
              storage: textStorage.name,
            },
          ],
        });

        // await db.sync();

        const response = await agent.resource('attachments').create({
          attachmentField: `${collectionName}.avatar`,
          file: path.resolve(__dirname, './files/image.jpg'),
        });

        expect(response.status).toBe(400);
      });

      it('upload to storage which is not default', async () => {
        const BASE_URL = `http://localhost:${APP_PORT}/storage/uploads/another`;
        const urlPath = 'test/path';

        // 动态添加 storage
        const storage = await StorageRepo.create({
          values: {
            name: 'localPrivate',
            type: STORAGE_TYPE_LOCAL,
            rules: {
              mimetype: ['text/*'],
            },
            path: urlPath,
            baseUrl: BASE_URL,
            options: {
              documentRoot: 'storage/uploads/another',
            },
          },
        });

        const collectionName = 'customersPrivateStorage';
        db.collection({
          name: collectionName,
          fields: [
            {
              name: 'file',
              type: 'belongsTo',
              target: 'attachments',
              storage: storage.name,
            },
          ],
        });

        const { body } = await agent.resource('attachments').create({
          attachmentField: `${collectionName}.file`,
          file: textFilePath,
        });

        // 文件的 url 是否正常生成
        expect(body.data.url).toBe(`${BASE_URL}/${urlPath}/${body.data.filename}`);
        const url = body.data.url.replace(`http://localhost:${APP_PORT}`, '');
        const content = await agent.get(url);
        expect(content.text).toBe(textFileExpectedContent);
      });
    });
  });

  describe('destroy', () => {
    it('destroy one existing file with `paranoid`', async () => {
      const collectionName = 'customersParanoidDestroy';
      db.collection({
        name: collectionName,
        fields: [
          {
            name: 'file',
            type: 'belongsTo',
            target: 'attachments',
            storage: 'local1',
          },
        ],
      });

      await db.sync();

      const { body } = await agent.resource('attachments').create({
        [FILE_FIELD_NAME]: textFilePath,
        attachmentField: `${collectionName}.file`,
      });

      const { data: attachment } = body;

      // 关联的存储引擎是否正确
      const storage = await StorageRepo.findById(attachment.storageId);

      const { documentRoot = 'storage/uploads' } = storage.options || {};
      const destPath = path.resolve(
        path.isAbsolute(documentRoot) ? documentRoot : path.join(process.env.TEGO_RUNTIME_HOME, documentRoot),
        storage.path,
      );
      const file = await fs.stat(path.join(destPath, attachment.filename));
      expect(file).toBeTruthy();

      const res2 = await agent.resource('attachments').destroy({ filterByTk: attachment.id });

      const attachmentExists = await AttachmentRepo.findById(attachment.id);
      expect(attachmentExists).toBeNull();

      const fileExists = await fs.stat(path.join(destPath, attachment.filename)).catch(() => false);
      expect(fileExists).toBeTruthy();
    });

    it('destroy one existing file', async () => {
      const { body } = await agent.resource('attachments').create({
        [FILE_FIELD_NAME]: textFilePath,
      });

      const { data: attachment } = body;

      const storage = await StorageRepo.findById(attachment.storageId);

      const { documentRoot = path.join('storage', 'uploads') } = storage.options || {};
      const destPath = path.resolve(
        path.isAbsolute(documentRoot) ? documentRoot : path.join(process.env.TEGO_RUNTIME_HOME, documentRoot),
        storage.path,
      );
      const file = await fs.stat(path.join(destPath, attachment.filename));
      expect(file).toBeTruthy();

      const res2 = await agent.resource('attachments').destroy({ filterByTk: attachment.id });

      const attachmentExists = await AttachmentRepo.findById(attachment.id);
      expect(attachmentExists).toBeNull();

      const fileExists = await fs.stat(path.join(destPath, attachment.filename)).catch(() => false);
      expect(fileExists).toBeFalsy();
    });

    it('destroy multiple existing files', async () => {
      const { body: f1 } = await agent.resource('attachments').create({
        [FILE_FIELD_NAME]: textFilePath,
      });

      const { body: f2 } = await agent.resource('attachments').create({
        [FILE_FIELD_NAME]: textFilePath,
      });

      const storage = await StorageRepo.findOne({
        filter: {
          name: 'local1',
        },
      });

      const { documentRoot = path.join('storage', 'uploads') } = storage.options || {};
      const destPath = path.resolve(
        path.isAbsolute(documentRoot) ? documentRoot : path.join(process.env.TEGO_RUNTIME_HOME, documentRoot),
        storage.path,
      );
      const file1 = await fs.stat(path.join(destPath, f1.data.filename));
      expect(file1).toBeTruthy();

      const res2 = await agent.resource('attachments').destroy({ filter: { id: [f1.data.id, f2.data.id] } });

      const attachmentExists = await AttachmentRepo.count();
      expect(attachmentExists).toBe(0);

      const file1Exists = await fs.stat(path.join(destPath, f1.data.filename)).catch(() => false);
      expect(file1Exists).toBeFalsy();

      const file2Exists = await fs.stat(path.join(destPath, f2.data.filename)).catch(() => false);
      expect(file2Exists).toBeFalsy();
    });

    it('destroy record without file exists should be ok', async () => {
      const { body } = await agent.resource('attachments').create({
        [FILE_FIELD_NAME]: textFilePath,
      });

      const { data: attachment } = body;

      const storage = await StorageRepo.findById(attachment.storageId);

      const { documentRoot = path.join('storage', 'uploads') } = storage.options || {};
      const destPath = path.resolve(
        path.isAbsolute(documentRoot) ? documentRoot : path.join(process.env.TEGO_RUNTIME_HOME, documentRoot),
        storage.path,
      );
      const filePath = path.join(destPath, attachment.filename);
      const file = await fs.stat(filePath);
      expect(file).toBeTruthy();
      await fs.unlink(filePath);

      const res2 = await agent.resource('attachments').destroy({ filterByTk: attachment.id });
      expect(res2.status).toBe(200);

      const attachmentExists = await AttachmentRepo.findById(attachment.id);
      expect(attachmentExists).toBeNull();
    });
  });
});

import { resolve } from 'node:path';
import { Plugin } from '@tego/server';

import initActions from './actions';
import { FileModel } from './FileModel';
import { getStorageConfig } from './storages';

export { default as storageTypes } from './storages';

export default class PluginFileManager extends Plugin {
  storageType() {
    return 'local';
  }

  async loadStorages(options?: { transaction: any }) {
    const repository = this.db.getRepository('storages');
    const storages = await repository.find({
      transaction: options?.transaction,
    });
    const map = new Map();
    for (const storage of storages) {
      map.set(storage.get('id'), this.parseStorage(storage));
    }
    this.db['_fileStorages'] = map;
  }

  parseStorage(instance) {
    return this.app.environment.renderJsonTemplate(instance.toJSON());
  }

  async install() {
    const defaultStorageConfig = getStorageConfig(this.storageType());

    if (defaultStorageConfig) {
      const Storage = this.db.getCollection('storages');
      if (
        await Storage.repository.findOne({
          filter: {
            name: defaultStorageConfig.defaults().name,
          },
        })
      ) {
        return;
      }
      await Storage.repository.create({
        values: {
          ...defaultStorageConfig.defaults(),
          type: this.storageType(),
          default: true,
        },
      });
    }
  }

  async beforeLoad() {
    this.db.registerModels({ FileModel });
    this.db.on('beforeDefineCollection', (options) => {
      if (options.template === 'file') {
        options.model = 'FileModel';
      }
    });
    this.app.on('afterStart', async () => {
      await this.loadStorages();
    });
  }

  async load() {
    // 如果基类的 loadCollections() 没有导入 collections（packageName 未设置），手动导入
    const collectionsDir = resolve(__dirname, './collections');
    const storagesCollection = this.db.getCollection('storages');
    if (!storagesCollection) {
      await this.db.import({
        directory: collectionsDir,
        from: this.options.packageName || '@tachybase/module-file',
      });
    }

    const storagesCollectionAfterImport = this.db.getCollection('storages');
    if (!storagesCollectionAfterImport) {
      throw new Error('Collection storages is not defined after import');
    }

    const Storage = storagesCollectionAfterImport.model;
    Storage.afterSave(async (m, { transaction }) => {
      await this.loadStorages({ transaction });
    });
    Storage.afterDestroy(async (m, { transaction }) => {
      await this.loadStorages({ transaction });
    });

    this.app.acl.registerSnippet({
      name: `pm.file-manager.storages`,
      actions: ['storages:*'],
    });

    this.db.addMigrations({
      namespace: 'file-manager',
      directory: resolve(__dirname, 'migrations'),
      context: {
        plugin: this,
      },
    });

    initActions(this);

    this.app.acl.allow('attachments', 'upload', 'loggedIn');
    this.app.acl.allow('attachments', 'create', 'loggedIn');

    // this.app.resourcer.use(uploadMiddleware);
    // this.app.resourcer.use(createAction);
    // this.app.resourcer.registerActionHandler('upload', uploadAction);

    const defaultStorageName = getStorageConfig(this.storageType()).defaults().name;

    this.app.acl.addFixedParams('storages', 'destroy', () => {
      return {
        filter: { 'name.$ne': defaultStorageName },
      };
    });

    const ownMerger = () => {
      return {
        filter: {
          createdById: '{{ctx.state.currentUser.id}}',
        },
      };
    };

    this.app.acl.addFixedParams('attachments', 'update', ownMerger);
    this.app.acl.addFixedParams('attachments', 'create', ownMerger);
    this.app.acl.addFixedParams('attachments', 'destroy', ownMerger);
  }
}

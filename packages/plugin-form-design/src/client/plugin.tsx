import { Plugin } from '@tachybase/client';

class PluginFormDesignClient extends Plugin {
  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    this.app.addComponents({});

    // this.app.schemaInitializerManager.addItem('page:addBlock', 'dataBlocks.stepForm', stepFormBlockInitializerItem);

    // this.app.schemaInitializerManager.addItem(
    //   'popup:common:addBlock',
    //   'dataBlocks.stepForm',
    //   stepFormBlockInitializerItem,
    // );
    // this.app.schemaInitializerManager.addItem(
    //   'popup:addNew:addBlock',
    //   'dataBlocks.stepForm',
    //   stepFormBlockInitializerItem,
    // );
  }
}

export default PluginFormDesignClient;

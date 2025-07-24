import { Plugin } from '@tachybase/client';

import { formDesignInitializerItem } from './initializers/formDesignInitializerItem';

class PluginFormDesignClient extends Plugin {
  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    this.app.addComponents({});

    this.app.schemaInitializerManager.addItem('page:addBlock', 'otherBlocks.formDesign', formDesignInitializerItem);

    this.app.schemaInitializerManager.addItem(
      'popup:common:addBlock',
      'otherBlocks.formDesign',
      formDesignInitializerItem,
    );
    this.app.schemaInitializerManager.addItem(
      'popup:addNew:addBlock',
      'otherBlocks.formDesign',
      formDesignInitializerItem,
    );
  }
}

export default PluginFormDesignClient;

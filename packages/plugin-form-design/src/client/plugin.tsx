import { Plugin } from '@tachybase/client';

import { EditableFormItemSchemaToolbar, EditableFormToolbar } from './initializers/components/form-editor';
import { formDesignInitializerItem } from './initializers/formDesignInitializerItem';
import { FormDesignModalProvider } from './initializers/FormDesignModalProvider';

class PluginFormDesignClient extends Plugin {
  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    this.app.addProvider(FormDesignModalProvider);
    this.app.schemaInitializerManager.addItem('page:addBlock', 'otherBlocks.formDesign', formDesignInitializerItem);

    this.app.schemaInitializerManager.addItem(
      'popup:common:addBlock',
      'otherBlocks.formDesign',
      formDesignInitializerItem,
    );
    // this.app.schemaInitializerManager.addItem(
    //   'popup:addNew:addBlock',
    //   'otherBlocks.formDesign',
    //   formDesignInitializerItem,
    // );
    this.app.addComponents({
      EditableFormToolbar,
      EditableFormItemSchemaToolbar,
    });
  }
}

export default PluginFormDesignClient;

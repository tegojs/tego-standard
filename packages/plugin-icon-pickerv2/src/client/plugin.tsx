import { Plugin } from '@tachybase/client';

import { IconPickerV2 } from './IconPickerV2';

class PluginIconPickerV2 extends Plugin {
  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    this.app.addComponents({ IconPickerV2 });
  }
}

export default PluginIconPickerV2;

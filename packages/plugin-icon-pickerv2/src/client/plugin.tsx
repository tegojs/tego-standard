import { Plugin } from '@tachybase/client';

import { IconPickerV2 } from './IconPickerV2';
import { IconV2FieldInterface } from './interfaces/iconv2';

class PluginIconPickerV2 extends Plugin {
  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    this.app.addComponents({ IconPickerV2 });
    this.app.dataSourceManager.addFieldInterfaces([IconV2FieldInterface]);
  }
}

export default PluginIconPickerV2;

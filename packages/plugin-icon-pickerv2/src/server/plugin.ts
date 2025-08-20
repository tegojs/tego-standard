import { InjectedPlugin, Plugin } from '@tego/server';

import { IconPickerV2Controller } from './actions/IconPickerV2Controller';

@InjectedPlugin({
  Controllers: [IconPickerV2Controller],
})
export class PluginIconPickerV2 extends Plugin {
  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    this.app.acl.allow('iconStorage', '*', 'loggedIn');
  }

  async install() {}

  async afterEnable() {}

  async afterDisable() {}

  async remove() {}
}

export default PluginIconPickerV2;

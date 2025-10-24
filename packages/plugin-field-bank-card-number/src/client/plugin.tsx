import { Plugin } from '@tachybase/client';

import { BankCardFieldInterface } from './BankCardFieldInterface';
import { BankCardInput } from './BankCardInput';

class PluginPluginFieldBankCardNumber extends Plugin {
  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    // 注册银行卡输入组件
    this.app.addComponents({
      BankCardInput,
    });

    // 注册银行卡字段接口
    this.app.dataSourceManager.collectionFieldInterfaceManager.addFieldInterfaces([BankCardFieldInterface]);
  }
}

export default PluginPluginFieldBankCardNumber;

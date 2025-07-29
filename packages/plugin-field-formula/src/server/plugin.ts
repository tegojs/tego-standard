import { resolve } from 'node:path';

import { InstallOptions, Plugin } from '@tego/server';

import { FormulaField } from './field-formula';

export class FormulaFieldPlugin extends Plugin {
  afterAdd() {}

  beforeLoad() {
    this.db.registerFieldTypes({
      formula: FormulaField,
    });

    this.db.addMigrations({
      namespace: this.name,
      directory: resolve(__dirname, './migrations'),
      context: {
        plugin: this,
      },
    });
  }

  async load() {}

  async install(options?: InstallOptions) {}

  async afterEnable() {}

  async afterDisable() {}

  async remove() {}
}

export default FormulaFieldPlugin;

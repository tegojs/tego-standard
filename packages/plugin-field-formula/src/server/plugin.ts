import { resolve } from 'node:path';
import { evaluators, InstallOptions, Plugin } from '@tego/server';

import { FormulaField } from './field-formula';
import mathjs from './utils/mathjs';

export class FormulaFieldPlugin extends Plugin {
  afterAdd() {}

  beforeLoad() {
    if (!evaluators.get('math.js')) {
      evaluators.register('math.js', mathjs);
    }

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

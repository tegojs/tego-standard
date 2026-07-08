import { Plugin } from '@tachybase/client';
import { evaluators } from '@tego/client';

import { Formula } from './components';
import { FormulaFieldInterface } from './interfaces/formula';
import { renderExpressionDescription } from './scopes';
import mathjs from './utils/mathjs';

export class FormulaFieldPlugin extends Plugin {
  async load() {
    if (!evaluators.get('math.js')) {
      evaluators.register('math.js', {
        label: 'Math.js',
        tooltip: `{{t('Math.js comes with a large set of built-in functions and constants, and offers an integrated solution to work with different data types.')}}`,
        link: 'https://mathjs.org/',
        evaluate: mathjs,
      });
    }

    this.app.addComponents({
      Formula,
    });
    this.app.addScopes({
      renderExpressionDescription,
    });
    this.app.dataSourceManager.addFieldInterfaces([FormulaFieldInterface]);
  }
}

export default FormulaFieldPlugin;

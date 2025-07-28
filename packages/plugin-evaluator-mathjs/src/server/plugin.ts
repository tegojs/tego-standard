import evaluators from '@tachybase/evaluators';
import { Plugin } from '@tachybase/server';

import mathjs from './utils/mathjs';

export class PluginMathjsEvaluatorServer extends Plugin {
  async load() {
    if (!evaluators.get('math.js')) {
      evaluators.register('math.js', mathjs);
    }
  }
}

export default PluginMathjsEvaluatorServer;

import { Plugin } from '@tachybase/client';
import { evaluators } from '@tego/client';

import mathjs from './mathjs';

export class PluginMathjsEvaluatorClient extends Plugin {
  async load() {
    if (!evaluators.get('math.js')) {
      evaluators.register('math.js', mathjs);
    }
  }
}

export default PluginMathjsEvaluatorClient;

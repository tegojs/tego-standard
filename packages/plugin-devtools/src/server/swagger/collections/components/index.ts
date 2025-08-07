import { Collection } from '@tego/server';

import parameters from './parameters';
import schemas from './schemas';

export default (collection: Collection, options) => {
  return {
    ...schemas(collection, options),
    ...parameters(collection),
  };
};

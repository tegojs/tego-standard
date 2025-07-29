import { CollectionManager, DataSourceCollectionOptions } from '@tego/server';

import { HttpCollection } from './http-collection';

export class HttpCollectionManager extends CollectionManager {
  public dataSource: any;
  constructor(options: { dataSource?: any } = {}) {
    super(options);
    this.dataSource = options.dataSource;
  }
  newCollection(options: DataSourceCollectionOptions) {
    return new HttpCollection(options, this);
  }
}

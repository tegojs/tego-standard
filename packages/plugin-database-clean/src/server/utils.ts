import { Database } from '@tego/server';

import lodash from 'lodash';

export function sqlAdapter(database: Database, sql: string) {
  if (database.isMySQLCompatibleDialect()) {
    return lodash.replace(sql, /"/g, '`');
  }

  return sql;
}

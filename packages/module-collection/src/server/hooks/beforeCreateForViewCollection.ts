import { Database } from '@tego/server';

export function beforeCreateForViewCollection(db: Database) {
  return async (model, { transaction, context }) => {};
}

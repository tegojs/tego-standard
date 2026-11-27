import { isDeepStrictEqual } from 'node:util';
import type { ImportXlsxColumn } from '@tachybase/plugin-action-import';
import type { Collection, Database } from '@tego/server';

import { cloneDeep, invalid } from './write-support';

const scalarTypes = new Set([
  'string',
  'text',
  'integer',
  'bigInt',
  'float',
  'double',
  'real',
  'decimal',
  'boolean',
  'date',
]);

/** Shared by root imports and independently authorized reference lookups. Does not parse or query. */
export function captureScalarImportField(db: Database, collection: Collection, name: string) {
  const field = collection.getField(name);
  if (!field || !scalarTypes.has(field.type) || field.options.interface === 'attachment')
    invalid('Import field type requires its own adapter');
  const parserFor = () => db.fieldValueParsers.get(field.type) ?? db.fieldValueParsers.get('default');
  const parser = parserFor();
  const options = cloneDeep(field.options);
  const assertCurrent = () => {
    if (collection.getField(name) !== field || parserFor() !== parser || !isDeepStrictEqual(field.options, options))
      invalid('Import field or value parser changed during execution');
  };
  return {
    field,
    assertCurrent,
    createParser(ctx: object, column: ImportXlsxColumn) {
      assertCurrent();
      return db.buildFieldValueParser(field, { ...ctx, column: cloneDeep(column) });
    },
  };
}

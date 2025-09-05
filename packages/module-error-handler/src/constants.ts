export const DB_ERROR_MAP: { pattern: RegExp; code: string }[] = [
  { pattern: /value too long for type character varying/i, code: 'ERR_VALUE_TOO_LONG' },
  { pattern: /relation .* does not exist/i, code: 'ERR_RELATION_NOT_EXIST' },
  { pattern: /duplicate key value violates unique constraint/i, code: 'ERR_DUPLICATE_KEY' },
  {
    pattern: /must provide filter or filterByTk for update call, or set forceUpdate to true/i,
    code: 'ERR_MISSING_FILTER_UPDATE',
  },
  { pattern: /invalid input syntax for type timestamp with time zone/i, code: 'ERR_INVALID_TIMESTAMP' },
];

export const NAMESPACE = '@tachybase/module-error-handler';

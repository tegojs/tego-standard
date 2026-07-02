import { Context, Next, SqlCollection, SQLModel } from '@tego/server';

import { CollectionModel } from '../models';

/**
 * Check if the current user has the pm.database-connections.collections snippet.
 * SQL collection configuration actions (update, setFields) require this snippet
 * because they modify collection structure, which is an admin-level operation.
 *
 * Root role always passes. This mirrors the pattern used in workflow SQL
 * permission checks (assertSqlSnippetPermission).
 */
function assertCollectionConfigPermission(ctx: Context) {
  const roleName = ctx.state?.currentRole;
  if (!roleName) {
    ctx.throw(403, 'SQL collection configuration requires a valid role');
  }

  // root is always allowed
  if (roleName === 'root') {
    return;
  }

  const acl = ctx.app?.acl || ctx.tego?.acl;
  if (!acl) {
    ctx.throw(403, 'SQL collection configuration requires the pm.database-connections.collections permission');
  }

  const aclRole = acl.getRole(roleName);
  if (!aclRole) {
    ctx.throw(403, 'SQL collection configuration requires the pm.database-connections.collections permission');
  }

  const { allowed } = aclRole.effectiveSnippets();
  if (!allowed.includes('pm.database-connections.collections')) {
    ctx.throw(403, 'SQL collection configuration requires the pm.database-connections.collections permission');
  }
}

const updateCollection = async (ctx: Context, transaction: any) => {
  const { filterByTk, values } = ctx.action.params;
  const repo = ctx.db.getRepository('collections');
  const collection: CollectionModel = await repo.findOne({
    filter: {
      name: filterByTk,
    },
    transaction,
  });
  const existFields = await collection.getFields({ transaction });
  const deletedFields = existFields.filter((field: any) => !values.fields?.find((f: any) => f.name === field.name));
  for (const field of deletedFields) {
    await field.destroy({ transaction });
  }
  const upRes = await repo.update({
    filterByTk,
    values,
    updateAssociationValues: ['fields'],
    transaction,
  });

  return { collection, upRes };
};

function readDollarQuoteTag(sql: string, index: number) {
  const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(index));
  return match?.[0];
}

export function stripSqlCommentsAndLiterals(sql: string) {
  let normalized = '';
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (char === "'") {
      normalized += ' ';
      index += 1;
      while (index < sql.length) {
        if (sql[index] === "'" && sql[index + 1] === "'") {
          index += 2;
          continue;
        }
        if (sql[index] === "'") {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (char === '"') {
      normalized += ' ';
      index += 1;
      while (index < sql.length) {
        if (sql[index] === '"' && sql[index + 1] === '"') {
          index += 2;
          continue;
        }
        if (sql[index] === '"') {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (char === '`') {
      normalized += ' ';
      index += 1;
      while (index < sql.length) {
        if (sql[index] === '`' && sql[index + 1] === '`') {
          index += 2;
          continue;
        }
        if (sql[index] === '`') {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (char === '[') {
      normalized += ' ';
      index += 1;
      while (index < sql.length) {
        if (sql[index] === ']') {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    const dollarQuoteTag = char === '$' ? readDollarQuoteTag(sql, index) : undefined;
    if (dollarQuoteTag) {
      normalized += ' ';
      index += dollarQuoteTag.length;
      const closingIndex = sql.indexOf(dollarQuoteTag, index);
      index = closingIndex === -1 ? sql.length : closingIndex + dollarQuoteTag.length;
      continue;
    }

    if (char === '-' && next === '-') {
      normalized += ' ';
      index += 2;
      while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') {
        index += 1;
      }
      continue;
    }

    if (char === '#') {
      normalized += ' ';
      index += 1;
      while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') {
        index += 1;
      }
      continue;
    }

    if (char === '/' && next === '*') {
      normalized += ' ';
      index += 2;
      while (index < sql.length) {
        if (sql[index] === '*' && sql[index + 1] === '/') {
          index += 2;
          break;
        }
        index += 1;
      }
      continue;
    }

    normalized += char;
    index += 1;
  }

  return normalized;
}

export function isReadOnlyPreviewSql(sql: string) {
  const normalized = stripSqlCommentsAndLiterals(sql).trim();
  const startsWithRead = /^select\b/i.test(normalized) || /^with\b[\s\S]+\bselect\b/i.test(normalized);
  if (!startsWithRead) {
    return false;
  }

  return !/\b(insert|update|delete|merge|replace|create|alter|drop|truncate)\b/i.test(normalized);
}

/**
 * SQL collection resource.
 *
 * Tenant isolation boundary:
 * - `execute` runs raw SQL with no tenant filtering. The SQL is only validated
 *   to be a SELECT/CTE query (non-mutating for preview purposes), but there is
 *   no framework-level tenant scoping.
 * - `setFields` and `update` are configuration operations (not data access),
 *   and are gated by the default ACL deny-all for non-admin roles.
 * - No `tenantId` is injected into queries. The tenant resource guard does not
 *   apply to this resource because SQL collections do not have a `tenancy` option.
 * - If a tenant-scoped view of data is needed, users should construct their SQL
 *   to include the appropriate `WHERE tenantId = ...` clause manually, or use
 *   a general collection with proper tenancy configuration.
 */
export default {
  name: 'sqlCollection',
  actions: {
    execute: async (ctx: Context, next: Next) => {
      let {
        values: { sql },
      } = ctx.action.params;
      sql = sql.trim().split(';').shift();
      if (!sql) {
        ctx.throw(400, ctx.t('SQL is empty'));
      }
      if (!isReadOnlyPreviewSql(sql)) {
        ctx.throw(400, ctx.t('Only select query allowed'));
      }
      const tmpCollection = new SqlCollection({ name: 'tmp', sql }, { database: ctx.db });
      const model = tmpCollection.model as typeof SQLModel;
      // The result is for preview only, add limit clause to avoid too many results
      const data = await model.findAll({ attributes: ['*'], limit: 5, raw: true });
      let fields: {
        [field: string]: {
          type: string;
          source: string;
          collection: string;
          interface: string;
        };
      } = {};
      try {
        fields = model.inferFields();
      } catch (err) {
        ctx.logger.warn(`resource: sql-collection, action: execute, error: ${err}`);
        fields = {};
      }
      const sources = Array.from(new Set(Object.values(fields).map((field) => field.collection)));
      ctx.body = { data, fields, sources };
      await next();
    },
    setFields: async (ctx: Context, next: Next) => {
      assertCollectionConfigPermission(ctx);
      const transaction = await ctx.tego.db.sequelize.transaction();
      try {
        const {
          upRes: [collection],
        } = await updateCollection(ctx, transaction);
        await collection.loadFields({
          transaction,
        });
        await transaction.commit();
      } catch (e) {
        await transaction.rollback();
        throw e;
      }
      await next();
    },
    update: async (ctx: Context, next: Next) => {
      assertCollectionConfigPermission(ctx);
      const transaction = await ctx.tego.db.sequelize.transaction();
      try {
        const { upRes } = await updateCollection(ctx, transaction);
        const [collection] = upRes;
        await (collection as CollectionModel).load({ transaction, resetFields: true });
        await transaction.commit();
        ctx.body = upRes;
      } catch (e) {
        await transaction.rollback();
        throw e;
      }
      await next();
    },
  },
};

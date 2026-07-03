import { Context, Next, SqlCollection, SQLModel } from '@tego/server';

import { AST, Parser } from 'node-sql-parser';
import type { Transaction } from 'sequelize';

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

const sqlParser = new Parser();
const SQL_PARSE_DIALECTS = ['postgresql', 'mysql', 'sqlite'];

export function stripSqlCommentsAndLiterals(sql: string) {
  const ast = parseSql(sql);
  if (!ast) {
    return '';
  }

  return sqlParser.sqlify(ast);
}

function parseSql(sql: string) {
  for (const database of SQL_PARSE_DIALECTS) {
    try {
      return sqlParser.astify(sql, { database });
    } catch {
      // Try the next supported SQL dialect.
    }
  }

  return null;
}

type ReadOnlyAst = AST & {
  _next?: AST;
  into?: { position?: string | null } | null;
  with?: Array<{
    stmt?: AST | { ast?: AST };
  }> | null;
};

function getWithStatement(stmt: ReadOnlyAst['with'][number]['stmt']) {
  if (!stmt) {
    return null;
  }

  return 'ast' in stmt && stmt.ast ? stmt.ast : (stmt as AST);
}

function isReadOnlyStatement(ast: AST): boolean {
  const statement = ast as ReadOnlyAst;
  if (statement.type !== 'select') {
    return false;
  }

  if (statement.into?.position) {
    return false;
  }

  if (
    statement.with?.some((item) => !getWithStatement(item.stmt) || !isReadOnlyStatement(getWithStatement(item.stmt)))
  ) {
    return false;
  }

  if (statement._next && !isReadOnlyStatement(statement._next)) {
    return false;
  }

  return true;
}

export function isReadOnlyPreviewSql(sql: string) {
  const ast = parseSql(sql);
  if (!ast) {
    return false;
  }

  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1) {
    return false;
  }

  return isReadOnlyStatement(statements[0]);
}

function getDialect(ctx: Context) {
  return ctx.db.sequelize.getDialect?.() || ctx.db.options?.dialect;
}

async function applyReadOnlyTransactionGuard(ctx: Context, transaction: Transaction) {
  if (getDialect(ctx) === 'postgres') {
    await ctx.db.sequelize.query('SET TRANSACTION READ ONLY', { transaction });
  }
}

export async function runReadOnlyPreviewQuery(ctx: Context, model: typeof SQLModel) {
  return ctx.db.sequelize.transaction({ readOnly: true }, async (transaction) => {
    await applyReadOnlyTransactionGuard(ctx, transaction);

    // The result is for preview only, add limit clause to avoid too many results.
    return model.findAll({ attributes: ['*'], limit: 5, raw: true, transaction });
  });
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
      const data = await runReadOnlyPreviewQuery(ctx, model);
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

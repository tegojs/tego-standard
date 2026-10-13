import { normalizeAccessContextValue } from './context-values';
import {
  AccessRuleError,
  type AccessCondition,
  type AccessOperand,
  type AccessScopes,
  type CollectionMetadata,
  type CompileOptions,
  type ContextPath,
  type Scalar,
  type SqlScope,
} from './types';
import { validateAccessConfig } from './validate';

function sqlScope(sql: string, ...sources: SqlScope[]): SqlScope {
  return { sql, bind: Object.assign({}, ...sources.map((source) => source.bind)) };
}

function join(operator: 'AND' | 'OR', clauses: SqlScope[]): SqlScope {
  const identity = operator === 'AND' ? 'TRUE' : 'FALSE';
  const absorbing = operator === 'AND' ? 'FALSE' : 'TRUE';
  if (clauses.some((clause) => clause.sql === absorbing)) return sqlScope(absorbing);
  const remaining = clauses.filter((clause) => clause.sql !== identity);
  if (!remaining.length) return sqlScope(identity);
  return remaining.length === 1
    ? remaining[0]
    : sqlScope(`(${remaining.map((clause) => clause.sql).join(` ${operator} `)})`, ...remaining);
}

/** Produces predicates only; callers must still intersect role ACL and request filters. */
export function compileAccessScopes(input: unknown, options: CompileOptions): AccessScopes {
  const config = validateAccessConfig(input, options.collection);
  const parameterPrefix = options.parameterPrefix === undefined ? 'tac_' : options.parameterPrefix;
  if (typeof parameterPrefix !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(parameterPrefix)) {
    throw new AccessRuleError('INVALID_ACCESS_RULE', 'Invalid SQL parameter prefix');
  }
  let parameterIndex = 0;
  let aliasIndex = 0;
  const quote = options.quoteIdentifier;
  const rootAlias = options.rootAlias ?? 'tac_root';
  const aliases = new Set([rootAlias.toLowerCase()]);
  const nextAlias = (kind: string): string => {
    let alias: string;
    do {
      alias = `tac_${kind}_${aliasIndex++}`;
    } while (aliases.has(alias.toLowerCase()));
    aliases.add(alias.toLowerCase());
    return alias;
  };
  const bindValue = (value: Scalar): SqlScope => {
    const key = `${parameterPrefix}${parameterIndex++}`;
    return { sql: `$${key}`, bind: { [key]: value } };
  };
  const contextValue = (path: ContextPath): Scalar | Scalar[] => {
    const value = Object.hasOwn(options.context, path) ? options.context[path] : undefined;
    return normalizeAccessContextValue(path, value);
  };
  const field = (collection: CollectionMetadata, name: string, alias: string) =>
    `${quote(alias)}.${quote(collection.fields[name].column)}`;
  const table = (collection: CollectionMetadata) => collection.table.map((part) => quote(part)).join('.');
  const valueOf = (operand: Exclude<AccessOperand, { type: 'field' }>) =>
    operand.type === 'context' ? contextValue(operand.path) : operand.value;
  const operandSql = (operand: AccessOperand, collection: CollectionMetadata, alias: string): SqlScope => {
    if (operand.type === 'field') return sqlScope(field(collection, operand.path, alias));
    const value = valueOf(operand);
    if (Array.isArray(value)) {
      throw new AccessRuleError('INVALID_ACCESS_RULE', 'Expected a scalar operand');
    }
    return bindValue(value);
  };

  const compile = (condition: AccessCondition, collection: CollectionMetadata, alias: string): SqlScope => {
    switch (condition.type) {
      case 'constant':
        return sqlScope(condition.value ? 'TRUE' : 'FALSE');
      case 'all':
      case 'any':
        return join(
          condition.type === 'all' ? 'AND' : 'OR',
          condition.children.map((child) => compile(child, collection, alias)),
        );
      case 'not': {
        const child = compile(condition.child, collection, alias);
        return sqlScope(`(NOT (${child.sql}))`, child);
      }
      case 'isNull': {
        const operand = operandSql(condition.operand, collection, alias);
        return sqlScope(`(${operand.sql} IS NULL)`, operand);
      }
      case 'compare': {
        const left = operandSql(condition.left, collection, alias);
        // The validator forbids field-to-field comparisons.
        const rawRight = valueOf(condition.right as Exclude<AccessOperand, { type: 'field' }>);
        const format = condition.left.type === 'field' ? collection.fields[condition.left.path].formatValue : undefined;
        const right = format ? (Array.isArray(rawRight) ? rawRight.map(format) : format(rawRight)) : rawRight;
        if (condition.operator === 'in' || condition.operator === 'notIn') {
          if (!Array.isArray(right)) {
            throw new AccessRuleError('INVALID_ACCESS_RULE', 'Comparison requires a list');
          }
          if (!right.length) {
            return sqlScope(
              `(CASE WHEN ${left.sql} IS NULL THEN NULL ELSE ${condition.operator === 'in' ? 'FALSE' : 'TRUE'} END)`,
              left,
            );
          }
          const values = right.map(bindValue);
          return sqlScope(
            `(${left.sql} ${condition.operator === 'in' ? 'IN' : 'NOT IN'} (${values.map((value) => value.sql).join(', ')}))`,
            left,
            ...values,
          );
        }
        if (Array.isArray(right)) throw new AccessRuleError('INVALID_ACCESS_RULE', 'Expected a scalar comparison');
        if (condition.operator === 'includes') {
          const pattern = `%${String(right).replace(/[\\%_]/g, '\\$&')}%`;
          const value = bindValue(pattern);
          return sqlScope(`(${left.sql} LIKE ${value.sql} ESCAPE '\\')`, left, value);
        }
        const operators = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
        const value = bindValue(right);
        return sqlScope(`(${left.sql} ${operators[condition.operator]} ${value.sql})`, left, value);
      }
      case 'exists': {
        const segments = condition.path.split('.');
        const exists = (source: CollectionMetadata, sourceAlias: string, index: number): SqlScope => {
          const relation = source.associations[segments[index]];
          const targetAlias = nextAlias('relation');
          const targetSql = field(relation.target, relation.targetField, targetAlias);
          const sourceSql = field(source, relation.sourceField, sourceAlias);
          const innerCondition =
            index + 1 < segments.length
              ? exists(relation.target, targetAlias, index + 1)
              : compile(condition.condition, relation.target, targetAlias);
          const inner = join('AND', [
            innerCondition,
            ...(relation.target.constraints
              ? [compile(relation.target.constraints, relation.target, targetAlias)]
              : []),
            ...(relation.constraints ? [compile(relation.constraints, relation.target, targetAlias)] : []),
          ]);
          if (relation.through) {
            const throughAlias = nextAlias('link');
            const through = relation.through;
            const link = join('AND', [
              ...(through.collection.constraints
                ? [compile(through.collection.constraints, through.collection, throughAlias)]
                : []),
              ...(through.constraints ? [compile(through.constraints, through.collection, throughAlias)] : []),
            ]);
            return sqlScope(
              `EXISTS (SELECT 1 FROM ${table(through.collection)} AS ${quote(throughAlias)} ` +
                `INNER JOIN ${table(relation.target)} AS ${quote(targetAlias)} ON ` +
                `${field(through.collection, through.targetField, throughAlias)} = ${targetSql} ` +
                `WHERE ${field(through.collection, through.sourceField, throughAlias)} = ${sourceSql} AND (${inner.sql}) AND (${link.sql}))`,
              inner,
              link,
            );
          }
          return sqlScope(
            `EXISTS (SELECT 1 FROM ${table(relation.target)} AS ${quote(targetAlias)} ` +
              `WHERE ${targetSql} = ${sourceSql} AND (${inner.sql}))`,
            inner,
          );
        };
        return exists(collection, alias, 0);
      }
      case 'tenantRelation': {
        const activeTenant = contextValue('tenant.id') as string;
        const tenant = operandSql(condition.tenant, collection, alias);
        const relatives =
          condition.relation === 'same'
            ? []
            : (contextValue(
                condition.relation === 'ancestor' ? 'tenant.descendantIds' : 'tenant.ancestorIds',
              ) as string[]);
        const ids = [
          ...new Set([
            ...(condition.includeSelf ? [activeTenant] : []),
            ...relatives.filter((id) => id !== activeTenant),
          ]),
        ];
        // Preserve UNKNOWN for NULL even when the effective relationship set is empty.
        const values = ids.map(bindValue);
        return values.length
          ? sqlScope(`(${tenant.sql} IN (${values.map((value) => value.sql).join(', ')}))`, tenant, ...values)
          : sqlScope(`(CASE WHEN ${tenant.sql} IS NULL THEN NULL ELSE FALSE END)`, tenant);
      }
    }
  };

  const ownership: SqlScope[] = [];
  const visibility: SqlScope[] = [];
  for (const rule of config.rules) {
    if (!rule.enabled) continue;
    // Compile both branches before simplification so missing context cannot be hidden.
    const subject = compile(rule.subject, options.collection, rootAlias);
    const record = compile(rule.condition, options.collection, rootAlias);
    const scope = join('AND', [subject, record]);
    (rule.category === 'ownership' ? ownership : visibility).push(scope);
  }
  const root = options.collection.constraints
    ? compile(options.collection.constraints, options.collection, rootAlias)
    : sqlScope('TRUE');
  const g = join('AND', [root, join('OR', ownership)]);
  const v = join('AND', [root, join('OR', visibility)]);
  return { ownership: g, visibility: v, read: join('OR', [g, v]) };
}

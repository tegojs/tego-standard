import { Op, type Collection, type Model, type ModelStatic } from '@tego/server';

import {
  AccessRuleError,
  type AccessCondition,
  type AssociationMetadata,
  type CollectionMetadata,
  type FieldType,
  type Scalar,
} from './types';

function reject(message: string): never {
  throw new AccessRuleError('INVALID_ACCESS_RULE', message);
}

function group(children: AccessCondition[], type: 'all' | 'any' = 'all'): AccessCondition {
  return children.length
    ? children.length === 1
      ? children[0]
      : { type, children }
    : { type: 'constant', value: type === 'all' };
}

function plain(value: unknown): value is Record<PropertyKey, unknown> {
  return !!value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

/** Translate a deliberately bounded subset of Sequelize scopes; never discard unknown clauses. */
function scopeCondition(scope: unknown, metadata: CollectionMetadata): AccessCondition {
  let nodes = 0;
  const scalar = (value: unknown): Scalar => {
    if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
    if (
      value === null ||
      ['string', 'boolean'].includes(typeof value) ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      return value as Scalar;
    return reject('Unsupported model scope value');
  };
  const compare = (
    name: string,
    operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'notIn',
    value: unknown,
  ): AccessCondition => {
    const field = { type: 'field' as const, path: name };
    if (value === null && (operator === 'eq' || operator === 'ne')) {
      const condition: AccessCondition = { type: 'isNull', operand: field };
      return operator === 'eq' ? condition : { type: 'not', child: condition };
    }
    if (Array.isArray(value) && !value.length) {
      if (operator === 'notIn') return { type: 'constant', value: true };
      return reject('Unsupported empty model scope list');
    }
    return {
      type: 'compare',
      operator,
      left: field,
      right: { type: 'literal', value: Array.isArray(value) ? value.map(scalar) : scalar(value) },
    };
  };
  const operators = new Map<symbol, 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'notIn'>([
    [Op.eq, 'eq'],
    [Op.ne, 'ne'],
    [Op.gt, 'gt'],
    [Op.gte, 'gte'],
    [Op.lt, 'lt'],
    [Op.lte, 'lte'],
    [Op.in, 'in'],
    [Op.notIn, 'notIn'],
  ]);
  const compact = (children: Array<AccessCondition | undefined>) =>
    children.filter((child): child is AccessCondition => child !== undefined);
  const parse = (value: unknown, depth = 0): AccessCondition | undefined => {
    if (++nodes > 1000 || depth > 16) reject('Model scope exceeds size or depth limit');
    if (Array.isArray(value)) {
      const children = compact(value.map((child) => parse(child, depth + 1)));
      return children.length ? group(children) : undefined;
    }
    if (!plain(value)) return reject('Unsupported model scope expression');
    const children = compact(
      Reflect.ownKeys(value).map((name) => {
        const entry = value[name];
        if (name === Op.and || name === Op.or || name === Op.not) {
          const members = Array.isArray(entry)
            ? entry
            : plain(entry)
              ? Reflect.ownKeys(entry).map((key) => ({ [key]: entry[key] }))
              : reject('Unsupported model scope group');
          const nested = compact(members.map((child) => parse(child, depth + 1)));
          // Sequelize ignores empty clauses inside a group; OR/NOT with no clauses is false.
          if (!nested.length) return name === Op.and ? undefined : { type: 'constant' as const, value: false };
          const condition = group(nested, name === Op.or ? 'any' : 'all');
          return name === Op.not ? { type: 'not' as const, child: condition } : condition;
        }
        if (typeof name !== 'string' || !Object.hasOwn(metadata.fields, name))
          return reject('Unsupported model scope field or operator');
        if (plain(entry)) {
          if (!Reflect.ownKeys(entry).length) return reject('Unsupported empty model scope field');
          return group(
            Reflect.ownKeys(entry).map((operator) => {
              if ((operator === Op.is || operator === Op.not) && entry[operator] === null)
                return compare(name, operator === Op.is ? 'eq' : 'ne', null);
              const comparison = typeof operator === 'symbol' ? operators.get(operator) : undefined;
              if (!comparison) return reject('Unsupported model scope operator');
              return compare(name, comparison, entry[operator]);
            }),
          );
        }
        return compare(name, Array.isArray(entry) ? 'in' : 'eq', entry);
      }),
    );
    return children.length ? group(children) : undefined;
  };
  return parse(scope) ?? { type: 'constant', value: true };
}

interface ResolvedAssociation {
  associationType: string;
  source: ModelStatic<Model>;
  target: ModelStatic<Model>;
  sourceKey?: string;
  targetKey?: string;
  foreignKey: string;
  otherKey?: string;
  scope?: unknown;
  through?: { model: ModelStatic<Model>; scope?: unknown; paranoid?: boolean };
}

/** Only accept a Collection owned by this database; scopes are expanded lazily for referenced paths. */
export function resolveModelMetadata(
  root: Collection,
  options: { resolveCollectionKey: (collection: Collection) => string },
): CollectionMetadata {
  const db = root.db;
  if (!['postgres', 'sqlite'].includes(db.sequelize.getDialect()))
    return reject('Unsupported access rule database dialect');
  const cache = new Map<Collection, CollectionMetadata>();
  const keys = new Map<string, Collection>();
  const fromModel = (model: ModelStatic<Model>) => {
    const collection = db.modelCollection.get(model);
    if (!collection || collection.db !== db || model.sequelize !== db.sequelize)
      return reject('Cross-database or unregistered access rule association');
    return collection;
  };
  const resolve = (collection: Collection): CollectionMetadata => {
    if (cache.has(collection)) return cache.get(collection)!;
    const key = options.resolveCollectionKey(collection);
    if (typeof key !== 'string' || !key || (keys.has(key) && keys.get(key) !== collection))
      return reject('Missing or duplicate stable collection identifier');
    keys.set(key, collection);
    const model = collection.model;
    const name = model.getTableName();
    const table = typeof name === 'string' ? [name] : [name.schema, name.tableName].filter(Boolean);
    const metadata: CollectionMetadata = { key, table, fields: Object.create(null), associations: Object.create(null) };
    for (const [field, attribute] of Object.entries(model.rawAttributes)) {
      const dataType = (attribute.type as unknown as { key: string }).key;
      const type: FieldType | undefined = ['STRING', 'CHAR', 'TEXT', 'UUID', 'ENUM', 'CITEXT'].includes(dataType)
        ? 'string'
        : ['INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'MEDIUMINT'].includes(dataType)
          ? attribute.primaryKey
            ? 'id'
            : 'number'
          : ['DECIMAL', 'FLOAT', 'DOUBLE', 'REAL'].includes(dataType)
            ? 'number'
            : dataType === 'BOOLEAN'
              ? 'boolean'
              : ['DATE', 'DATEONLY'].includes(dataType)
                ? 'date'
                : undefined;
      if (type) {
        metadata.fields[field] = { column: attribute.field || field, type };
        if (type === 'date') {
          const dateType = attribute.type as { stringify: (value: unknown, options?: object) => string };
          metadata.fields[field].formatValue = (value) =>
            value == null
              ? value
              : dateType.stringify(dataType === 'DATE' ? new Date(String(value)) : value, {
                  timezone: db.options.timezone ?? '+00:00',
                });
        }
      }
    }
    // Sequelize keeps the effective scope here (including addScope/defaultScope overrides).
    const effective = (model as unknown as { _scope: unknown })._scope;
    if (!plain(effective) || Reflect.ownKeys(effective).some((name) => name !== 'where'))
      return reject('Unsupported model default scope options');
    const restrictions: AccessCondition[] = [];
    if (effective.where !== undefined) restrictions.push(scopeCondition(effective.where, metadata));
    if (model.options.paranoid) {
      const deletedAt = (model as unknown as { _timestampAttributes: { deletedAt?: string } })._timestampAttributes
        .deletedAt;
      if (!deletedAt || !metadata.fields[deletedAt]) return reject('Unsupported soft deletion metadata');
      const defaultValue = model.rawAttributes[deletedAt].defaultValue ?? null;
      restrictions.push(scopeCondition({ [deletedAt]: defaultValue }, metadata));
    }
    metadata.constraints = group(restrictions);
    cache.set(collection, metadata);
    for (const [alias, entry] of Object.entries(model.associations)) {
      Object.defineProperty(metadata.associations, alias, {
        enumerable: true,
        get: () => {
          const association = entry as unknown as ResolvedAssociation;
          if (association.source !== model) return reject('Invalid association source metadata');
          const target = resolve(fromModel(association.target));
          const belongsTo = association.associationType === 'BelongsTo';
          const manyToMany = association.associationType === 'BelongsToMany';
          if (!['BelongsTo', 'HasOne', 'HasMany', 'BelongsToMany'].includes(association.associationType))
            return reject('Unsupported access rule association type');
          const relation: AssociationMetadata = {
            target,
            sourceField: belongsTo ? association.foreignKey : association.sourceKey!,
            targetField: belongsTo || manyToMany ? association.targetKey! : association.foreignKey,
          };
          if (association.scope !== undefined) relation.constraints = scopeCondition(association.scope, target);
          if (manyToMany) {
            if (!association.through) return reject('Missing association link metadata');
            const through = resolve(fromModel(association.through.model));
            if (association.through.paranoid === false && association.through.model.options.paranoid)
              return reject('Unsupported association soft deletion override');
            relation.through = {
              collection: through,
              sourceField: association.foreignKey,
              targetField: association.otherKey!,
            };
            if (association.through.scope !== undefined)
              relation.through.constraints = scopeCondition(association.through.scope, through);
          }
          return relation;
        },
      });
    }
    return metadata;
  };
  fromModel(root.model);
  return resolve(root);
}

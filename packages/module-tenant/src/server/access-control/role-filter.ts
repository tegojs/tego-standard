import {
  literal,
  Op,
  type Collection,
  type Database,
  type Model,
  type ModelStatic,
  type WhereOptions,
} from '@tego/server';

import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import type { AccessFilterNode } from './filter-tree';
import { accessMetadataGuard } from './metadata-snapshot';
import { resolveModelMetadata } from './model-metadata';
import { AccessRequestFilterParser } from './request-filter';
import type { CollectionMetadata } from './types';
import { cloneDeep, invalid, plain } from './write-support';

/** Finalized role conditions only. Relationship facts never imply permission to read their payload. */
export class AccessRoleFilterCompiler {
  constructor(
    private readonly db: Database,
    private readonly resolveCollectionIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  ) {}

  compile(identity: AccessCollectionIdentity, filter: unknown): { where: WhereOptions; assertCurrent(): void } {
    identity = cloneDeep(identity);
    const rootKey = accessCollectionKey(identity);
    const root = this.db.getCollection(identity.collectionName);
    if (!root) invalid('Role filter collection is unavailable');
    const identities = new Map<Collection, { identity: AccessCollectionIdentity; key: string }>();
    const keys = new Map<string, Collection>();
    const resolve = (collection: Collection): AccessCollectionIdentity => {
      if (identities.has(collection)) return identities.get(collection)!.identity;
      if (
        collection.db !== this.db ||
        this.db.getCollection(collection.name) !== collection ||
        this.db.modelCollection.get(collection.model) !== collection ||
        collection.model.sequelize !== this.db.sequelize
      )
        invalid('Role filter model is not registered in this database');
      const actual = cloneDeep(this.resolveCollectionIdentity(collection));
      if (!actual || actual.collectionName !== collection.name || actual.dataSourceKey !== identity.dataSourceKey)
        invalid('Role filter collection identity is unavailable or belongs to another data source');
      const key = accessCollectionKey(actual);
      if ((collection === root && key !== rootKey) || (keys.has(key) && keys.get(key) !== collection))
        invalid('Role filter stable collection identity does not match');
      identities.set(collection, { identity: actual, key });
      keys.set(key, collection);
      return actual;
    };
    const snapshot = cloneDeep(filter);
    const assertResolved = (value: unknown): void => {
      if (typeof value === 'string' && (value.includes('{{') || value.includes('}}')))
        invalid('Role filter contains an unresolved ACL variable');
      if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          assertResolved(key);
          assertResolved(child);
        }
      }
    };
    assertResolved(snapshot);
    const tree = new AccessRequestFilterParser(this.db, (collection) => ({
      identity: resolve(collection),
      // This is an internal fact resolver, not a read/output grant.
      fields: [
        ...Object.keys(collection.model.rawAttributes).filter(
          (field) => (collection.model.rawAttributes[field].type as { key?: string }).key !== 'VIRTUAL',
        ),
        ...Object.keys(collection.model.associations),
      ],
    })).parse(identity, snapshot).filter;
    const metadata = resolveModelMetadata(root, {
      resolveCollectionKey: (collection) => accessCollectionKey(resolve(collection)),
    });
    const qi = this.db.sequelize.getQueryInterface();
    const quote = (name: string) => qi.quoteIdentifier(name);
    const generator = qi.queryGenerator as unknown as {
      getWhereConditions(where: WhereOptions, alias: string, model: ModelStatic<Model>): string;
      selectQuery(
        table: ReturnType<ModelStatic<Model>['getTableName']>,
        options: object,
        model: ModelStatic<Model>,
      ): string;
    };
    const orm = this.db.sequelize.constructor as unknown as {
      Utils: { mapOptionFieldNames<T extends object>(options: T, model: ModelStatic<Model>): T };
    };
    const column = (model: ModelStatic<Model>, field: string) => {
      if (!Object.hasOwn(model.rawAttributes, field)) invalid('Role filter association key is unavailable');
      return `${quote(model.name)}.${quote(model.rawAttributes[field].field || field)}`;
    };
    const scalar = (where: WhereOptions, model: ModelStatic<Model>) =>
      generator.getWhereConditions(orm.Utils.mapOptionFieldNames({ where }, model).where, model.name, model) || '1 = 1';
    const restrictions = (model: ModelStatic<Model>, scope?: unknown): WhereOptions => {
      // resolveModelMetadata validates this exact effective scope grammar before it is used.
      const runtime = model as unknown as {
        _scope: { where?: WhereOptions };
        _timestampAttributes: { deletedAt?: string };
      };
      const clauses: WhereOptions[] = [];
      if (runtime._scope.where !== undefined) clauses.push(cloneDeep(runtime._scope.where));
      if (model.options.paranoid) {
        const field = runtime._timestampAttributes.deletedAt!;
        clauses.push({ [field]: model.rawAttributes[field].defaultValue ?? null });
      }
      if (scope !== undefined) {
        if (!plain(scope)) invalid('Role filter association scope must be a plain object');
        clauses.push(cloneDeep(scope) as WhereOptions);
      }
      return { [Op.and]: clauses };
    };
    const select = (model: ModelStatic<Model>, fields: Array<[string, string]>, where: WhereOptions) =>
      generator
        .selectQuery(
          model.getTableName(),
          orm.Utils.mapOptionFieldNames(
            {
              tableAs: model.name,
              attributes: fields.map(([field, alias]) => literal(`${column(model, field)} AS ${quote(alias)}`)),
              where,
            },
            model,
          ),
          model,
        )
        .replace(/;\s*$/, '');
    const paths: Array<{ model: ModelStatic<Model>; path: readonly string[] }> = [{ model: root.model, path: [] }];
    let aliases = 0;
    const alias = () => {
      let result: string;
      do {
        result = `tac_role_${++aliases}`;
      } while (
        [...identities.keys()].some((collection) => collection.model.name.toLowerCase() === result.toLowerCase())
      );
      return quote(result);
    };
    let nodes = 0;
    const compile = (
      node: AccessFilterNode,
      model: ModelStatic<Model>,
      current: CollectionMetadata,
      path: readonly string[],
    ): string => {
      if (++nodes > 1000) invalid('Role filter exceeds compilation size limit');
      switch (node.type) {
        case 'predicate':
          return scalar(node.where, model);
        case 'all':
        case 'any':
          return node.children.length
            ? `(${node.children.map((child) => compile(child, model, current, path)).join(node.type === 'all' ? ' AND ' : ' OR ')})`
            : node.type === 'all'
              ? '1 = 1'
              : '1 = 0';
        case 'not':
          return `NOT (${compile(node.child, model, current, path)})`;
        case 'association': {
          const relation = current.associations[node.association];
          if (!relation) invalid('Role filter association metadata is unavailable');
          const registered = model.associations[node.association] as (typeof model.associations)[string] & {
            scope?: unknown;
            through?: { model: ModelStatic<Model>; scope?: unknown };
          };
          const target = registered.target as ModelStatic<Model>;
          const targetPath = [...path, node.association];
          paths.push({ model: root.model, path: targetPath });
          const condition = node.condition ? compile(node.condition, target, relation.target, targetPath) : '1 = 1';
          const targetSql = select(target, [[relation.targetField, 'target_key']], {
            [Op.and]: [restrictions(target, registered.scope), literal(condition)],
          });
          const targetAlias = alias();
          let correlation = `${targetAlias}.${quote('target_key')} = ${column(model, relation.sourceField)}`;
          if (relation.through) {
            const through = registered.through!.model;
            const throughSql = select(
              through,
              [
                [relation.through.sourceField, 'source_key'],
                [relation.through.targetField, 'target_key'],
              ],
              restrictions(through, registered.through!.scope),
            );
            const throughAlias = alias();
            correlation = `EXISTS (SELECT 1 FROM (${throughSql}) AS ${throughAlias} WHERE ${throughAlias}.${quote('source_key')} = ${column(model, relation.sourceField)} AND ${throughAlias}.${quote('target_key')} = ${targetAlias}.${quote('target_key')})`;
          }
          return `${node.exists ? '' : 'NOT '}EXISTS (SELECT 1 FROM (${targetSql}) AS ${targetAlias} WHERE ${correlation})`;
        }
      }
    };
    const where = literal(compile(tree, root.model, metadata, []));
    const metadataCurrent = accessMetadataGuard(this.db, [], paths);
    const assertCurrent = () => {
      metadataCurrent();
      for (const [collection, captured] of identities) {
        const current = this.resolveCollectionIdentity(collection);
        if (
          !current ||
          current.collectionName !== captured.identity.collectionName ||
          accessCollectionKey(current) !== captured.key
        )
          invalid('Role filter stable collection identity changed during query');
      }
    };
    assertCurrent();
    return { where, assertCurrent };
  }
}

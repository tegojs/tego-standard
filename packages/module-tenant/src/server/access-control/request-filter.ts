import { FilterParser, Op, type Collection, type Database, type WhereOptions } from '@tego/server';

import type { AccessCollectionIdentity } from './config-store';
import { dateFilterOperators, normalizeDateFilterOperand } from './date-filter';
import { captureAccessFilter } from './filter-input';
import type { AccessFilterNode, AccessFilterTreeRequest } from './filter-tree';
import { invalid } from './write-support';

/** Resolved by the entry's existing role/association ACL protocol, never by request values. */
export interface AccessFilterReadGrant {
  identity: AccessCollectionIdentity;
  fields: readonly string[];
  where?: WhereOptions;
  bind?: Record<string, unknown>;
}

export type AccessFilterGrantResolver = (
  collection: Collection,
  path: readonly string[],
) => AccessFilterReadGrant | null;

interface ParsedAssociation {
  identity: AccessCollectionIdentity;
  grant: AccessFilterReadGrant;
  values: unknown[];
  exists: boolean;
  through?: AccessCollectionIdentity;
  throughWhere?: WhereOptions;
  throughBind?: Record<string, unknown>;
}

/** Internal JSON-to-tree adapter. It does not register a resource or change existing requests. */
export class AccessRequestFilterParser {
  constructor(
    private readonly db: Database,
    private readonly resolveGrant: AccessFilterGrantResolver,
  ) {}

  parse(source: AccessCollectionIdentity, filter: unknown): AccessFilterTreeRequest {
    const dateTimezone = this.db.options.timezone ?? '+00:00';
    const snapshot = captureAccessFilter(filter);
    const root = this.collection(source);
    const rootGrant = this.grant(root, [], source);
    const parsed = this.parseObjects(root, source, [], [snapshot], rootGrant, dateTimezone);
    return {
      filter: parsed,
      sourceWhere: rootGrant.where,
      sourceBind: rootGrant.bind,
    };
  }

  private collection(identity: AccessCollectionIdentity): Collection {
    const collection = this.db.getCollection(identity.collectionName);
    if (!collection) invalid('Request filter collection is unavailable');
    return collection;
  }

  private grant(
    collection: Collection,
    path: readonly string[],
    expected?: AccessCollectionIdentity,
  ): AccessFilterReadGrant {
    const grant = this.resolveGrant(collection, path);
    if (
      !grant ||
      grant.identity.collectionName !== collection.name ||
      (expected &&
        (grant.identity.dataSourceKey !== expected.dataSourceKey ||
          grant.identity.collectionKey !== expected.collectionKey ||
          grant.identity.collectionName !== expected.collectionName)) ||
      !Array.isArray(grant.fields) ||
      grant.fields.some((field) => typeof field !== 'string')
    )
      invalid('Request filter field or association is not authorized');
    return grant;
  }

  private parseObjects(
    collection: Collection,
    identity: AccessCollectionIdentity,
    path: readonly string[],
    values: unknown[],
    grant: AccessFilterReadGrant,
    dateTimezone: string,
  ): AccessFilterNode {
    if (path.length > 8) invalid('Request filter association path exceeds depth limit');
    if (values.some((value) => !value || typeof value !== 'object' || Array.isArray(value)))
      invalid('Request filter group must be an object');
    const predicates: AccessFilterNode[] = [];
    const associations = new Map<string, ParsedAssociation>();
    const addPath = (parts: string[], operand: unknown) => {
      if (!parts.length || parts.some((part) => !part || part === '__proto__' || part === 'constructor'))
        invalid('Request filter path is invalid');
      let current = collection;
      let currentIdentity = identity;
      let currentPath = [...path];
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index];
        const association = current.model.associations[part];
        if (association) {
          if (!grant.fields.includes(part)) invalid('Request filter association field is not authorized');
          const target = this.db.modelCollection.get(association.target);
          if (!target || target.db !== this.db) invalid('Request filter association is unavailable');
          const targetPath = [...currentPath, part];
          const targetGrant = this.grant(target, targetPath);
          const targetIdentity = targetGrant.identity;
          if (targetIdentity.dataSourceKey !== currentIdentity.dataSourceKey)
            invalid('Cross-data-source request filter associations are unsupported');
          let entry = associations.get(part);
          if (!entry) {
            entry = { identity: targetIdentity, grant: targetGrant, values: [], exists: true };
            associations.set(part, entry);
          }
          const throughAssociation = association as typeof association & {
            through?: { model?: Collection['model']; scope?: unknown };
          };
          if (association.associationType === 'BelongsToMany') {
            const through =
              throughAssociation.through?.model && this.db.modelCollection.get(throughAssociation.through.model);
            if (!through || through.db !== this.db) invalid('Request filter through collection is unavailable');
            const throughGrant = this.grant(through, [...targetPath, '$through']);
            Object.assign(entry, {
              through: throughGrant.identity,
              throughWhere: throughGrant.where,
              throughBind: throughGrant.bind,
            });
          }
          current = target;
          currentIdentity = targetIdentity;
          currentPath = targetPath;
          const tail = parts.slice(index + 1);
          const nested = tail.reduceRight<unknown>((child, name) => ({ [name]: child }), operand);
          entry.values.push(nested);
          return;
        }
        if (index !== parts.length - 1) invalid(`Unknown request filter association: ${part}`);
        if (!grant.fields.includes(part))
          invalid(`Request filter field is not authorized: ${[...currentPath, part].join('.')}`);
        const local = this.parseField(current, part, operand, dateTimezone);
        predicates.push({ type: 'predicate', where: local });
      }
    };
    const entries = values.flatMap((value) => Object.entries(value as Record<string, unknown>));
    const ordinaryPaths = new Set<string>();
    const separatePaths: Set<string>[] = [];
    for (const [key, item] of entries) {
      if (key === '$and' || key === '$or') {
        if (!Array.isArray(item) || item.length > 100) invalid(`Request ${key} must be a bounded list`);
        for (const child of item) separatePaths.push(this.associationPaths(collection, path, child));
      } else if (key === '$not' || key.endsWith('.$exists') || key.endsWith('.$notExists')) {
        separatePaths.push(this.associationPaths(collection, path, key === '$not' ? item : { [key]: item }));
      } else {
        for (const associationPath of this.associationPaths(collection, path, { [key]: item }))
          ordinaryPaths.add(associationPath);
      }
    }
    const seenPaths = new Set(ordinaryPaths);
    for (const paths of separatePaths) {
      for (const associationPath of paths) {
        if (
          [...seenPaths].some(
            (previous) =>
              associationPath === previous ||
              associationPath.startsWith(`${previous}.`) ||
              previous.startsWith(`${associationPath}.`),
          )
        )
          invalid('Group conditions on the same association must be combined in one filter object');
      }
      for (const associationPath of paths) seenPaths.add(associationPath);
    }
    for (const [key, item] of entries) {
      if (key === '$and' || key === '$or') {
        const children = (item as unknown[]).map((child) =>
          this.parseObjects(collection, identity, path, [child], grant, dateTimezone),
        );
        predicates.push({ type: key === '$and' ? 'all' : 'any', children });
      } else if (key === '$not') {
        predicates.push({
          type: 'not',
          child: this.parseObjects(collection, identity, path, [item], grant, dateTimezone),
        });
      } else {
        const parts = key.split('.');
        const last = parts.at(-1);
        if (last === '$exists' || last === '$notExists') {
          const associationParts = parts.slice(0, -1);
          const targetPrimaryKey = associationParts.at(-1) === 'id';
          if (targetPrimaryKey) associationParts.pop();
          if (this.isAssociationPath(collection, associationParts)) {
            if (item !== true) invalid('Association existence filters require an explicit true marker');
            predicates.push(
              this.parseAssociationExistence(
                collection,
                identity,
                path,
                associationParts,
                last === '$exists',
                targetPrimaryKey,
                grant,
              ),
            );
          } else {
            addPath(parts.slice(0, -1), { [last]: item });
          }
        } else {
          addPath(parts, item);
        }
      }
    }
    for (const [association, entry] of associations) {
      predicates.push({
        type: 'association',
        association,
        target: entry.identity,
        exists: entry.exists,
        targetWhere: entry.grant.where,
        targetBind: entry.grant.bind,
        ...(entry.through
          ? {
              through: entry.through,
              throughWhere: entry.throughWhere,
              throughBind: entry.throughBind,
            }
          : {}),
        condition: this.parseObjects(
          this.collection(entry.identity),
          entry.identity,
          [...path, association],
          entry.values,
          entry.grant,
          dateTimezone,
        ),
      });
    }
    return predicates.length === 1 ? predicates[0] : { type: 'all', children: predicates };
  }

  private associationPaths(collection: Collection, prefix: readonly string[], input: unknown): Set<string> {
    const paths = new Set<string>();
    const visit = (current: Collection, currentPath: readonly string[], value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (key === '$and' || key === '$or') {
          if (Array.isArray(child)) for (const nested of child) visit(current, currentPath, nested);
          continue;
        }
        if (key === '$not') {
          visit(current, currentPath, child);
          continue;
        }
        const parts = key.split('.');
        if (parts.at(-1) === '$exists' || parts.at(-1) === '$notExists') parts.pop();
        if (parts.at(-1) === 'id' && parts.length > 1) parts.pop();
        let targetCollection = current;
        const targetPath = [...currentPath];
        for (const part of parts) {
          const relation = targetCollection.model.associations[part];
          const target = relation && this.db.modelCollection.get(relation.target);
          if (!target) break;
          targetPath.push(part);
          paths.add(targetPath.join('.'));
          targetCollection = target;
        }
        if (targetCollection !== current && key === parts[0]) visit(targetCollection, targetPath, child);
      }
    };
    visit(collection, prefix, input);
    return paths;
  }

  private isAssociationPath(source: Collection, parts: string[]): boolean {
    if (!parts.length) return false;
    let collection = source;
    for (const part of parts) {
      const relation = collection.model.associations[part];
      const target = relation && this.db.modelCollection.get(relation.target);
      if (!target) return false;
      collection = target;
    }
    return true;
  }

  private parseAssociationExistence(
    source: Collection,
    sourceIdentity: AccessCollectionIdentity,
    path: readonly string[],
    parts: string[],
    exists: boolean,
    targetPrimaryKey: boolean,
    sourceGrant: AccessFilterReadGrant,
  ): AccessFilterNode {
    if (!parts.length) invalid('Association existence filter requires a registered relation');
    if (path.length + parts.length > 8) invalid('Request filter association path exceeds depth limit');
    const [name, ...tail] = parts;
    if (!sourceGrant.fields.includes(name)) invalid('Request filter association field is not authorized');
    const relation = source.model.associations[name];
    const target = relation && this.db.modelCollection.get(relation.target);
    if (!relation || !target || target.db !== this.db) invalid('Association existence path is unavailable');
    const targetPath = [...path, name];
    const targetGrant = this.grant(target, targetPath);
    if (targetGrant.identity.dataSourceKey !== sourceIdentity.dataSourceKey)
      invalid('Cross-data-source request filter associations are unsupported');
    let condition: AccessFilterNode;
    let relationExists = true;
    if (tail.length) {
      condition = this.parseAssociationExistence(
        target,
        targetGrant.identity,
        targetPath,
        tail,
        exists,
        targetPrimaryKey,
        targetGrant,
      );
    } else {
      if (targetPrimaryKey && target.model.primaryKeyAttribute !== 'id')
        invalid('Existence filters only support the registered id primary key');
      condition = { type: 'all', children: [] };
      relationExists = exists;
    }
    const throughAssociation = relation as typeof relation & { through?: { model?: Collection['model'] } };
    const through = throughAssociation.through?.model && this.db.modelCollection.get(throughAssociation.through.model);
    if (relation.associationType === 'BelongsToMany' && (!through || through.db !== this.db))
      invalid('Association through collection is unavailable');
    const throughGrant = through ? this.grant(through, [...targetPath, '$through']) : undefined;
    return {
      type: 'association',
      association: name,
      target: targetGrant.identity,
      exists: relationExists,
      targetWhere: targetGrant.where,
      targetBind: targetGrant.bind,
      ...(throughGrant
        ? { through: throughGrant.identity, throughWhere: throughGrant.where, throughBind: throughGrant.bind }
        : {}),
      condition,
    };
  }

  private parseField(collection: Collection, field: string, value: unknown, dateTimezone: string): WhereOptions {
    const fieldType = collection.getField(field)?.type;
    if (fieldType === 'array' || fieldType === 'json' || fieldType === 'jsonb')
      invalid('Request filtering does not support JSON or array fields');
    const allowed = new Set([
      '$eq',
      '$ne',
      '$gt',
      '$gte',
      '$lt',
      '$lte',
      '$in',
      '$notIn',
      '$includes',
      '$notIncludes',
      '$startsWith',
      '$notStartsWith',
      '$endWith',
      '$notEndWith',
      '$empty',
      '$notEmpty',
      '$isFalsy',
      '$isTruly',
      '$exists',
      '$notExists',
      ...dateFilterOperators,
    ]);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (
        !keys.length ||
        keys.some((key) => typeof key !== 'string' || !allowed.has(key) || !this.db.operators.has(key))
      )
        invalid('Request filter operator is unsupported');
      const normalized: Record<string, unknown> = {};
      for (const key of keys as string[]) {
        const operand = (value as Record<string, unknown>)[key];
        if ((dateFilterOperators as readonly string[]).includes(key)) {
          if (
            !['DATE', 'DATEONLY'].includes((collection.model.rawAttributes[field]?.type as { key?: string })?.key ?? '')
          )
            invalid('Date filter operators require a physical date field');
          normalized[key] = normalizeDateFilterOperand(key, operand, dateTimezone);
        } else {
          this.assertFieldValue(operand);
          normalized[key] = operand;
        }
      }
      // Core field-operator merging can overwrite shared symbols such as Op.and.
      // Keep each date predicate intact when intersecting it with other operators.
      if (keys.length > 1 && keys.some((key) => (dateFilterOperators as readonly string[]).includes(key as string)))
        return {
          [Op.and]: Object.entries(normalized).map(([key, operand]) =>
            this.parseField(collection, field, { [key]: operand }, dateTimezone),
          ),
        };
      value = normalized;
    } else {
      this.assertFieldValue(value);
    }
    const parsed = new FilterParser({ [field]: value }, { collection }).toSequelizeParams();
    if (parsed.include?.length || Object.keys(parsed.where ?? {}).some((key) => key.includes('.'))) {
      if (Object.hasOwn(parsed.where ?? {}, field)) return parsed.where as WhereOptions;
      invalid('Nested association filters must use registered association paths');
    }
    return parsed.where as WhereOptions;
  }

  private assertFieldValue(value: unknown): void {
    if (Array.isArray(value)) {
      for (const entry of value) this.assertFieldValue(entry);
      return;
    }
    if (value !== null && typeof value === 'object') invalid('Request filter operators require scalar JSON values');
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value))
      invalid('Request filter operators require scalar JSON values');
  }
}

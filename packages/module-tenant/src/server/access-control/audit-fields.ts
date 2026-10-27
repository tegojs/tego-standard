import { isDeepStrictEqual } from 'node:util';
import type { Collection, Database } from '@tego/server';

import type { AccessIdentity } from './context';
import { invalid, normalizeKeys } from './write-support';

/** Server context FKs only; this never permits submitting these fields in request values. */
export function captureUserAuditFields(db: Database, collection: Collection, actor: AccessIdentity) {
  const model = collection.model;
  const users = db.getCollection('users');
  const userModel = users?.model;
  const userPrimary = userModel?.primaryKeyAttribute;
  const userAttribute = userModel?.rawAttributes[userPrimary];
  const userType = (userAttribute?.type as { key?: string })?.key;
  const userColumn = userAttribute?.field;
  const discover = () => {
    const fields = new Map<
      string,
      {
        field: ReturnType<Collection['getField']>;
        createOnly: boolean;
        dataType: unknown;
        attribute: object;
        column: string | undefined;
        type: string;
        references: object[];
      }
    >();
    if (!userModel || userModel.primaryKeyAttributes.length !== 1) return fields;
    for (const [name, attribute] of Object.entries(model.rawAttributes)) {
      const field = collection.getField(name);
      if (
        field?.type !== 'context' ||
        model.primaryKeyAttributes.includes(name) ||
        field.options.dataIndex !== 'state.currentUser.id' ||
        (field.options.createOnly !== undefined && typeof field.options.createOnly !== 'boolean') ||
        !['BIGINT', 'INTEGER', 'STRING', 'TEXT', 'UUID'].includes((attribute.type as { key?: string }).key)
      )
        continue;
      const references = Object.values(model.associations).filter(
        (entry) =>
          entry.associationType === 'BelongsTo' &&
          (entry as typeof entry & { foreignKey?: string }).foreignKey === name,
      );
      if (
        !references.length ||
        references.some(
          (entry) =>
            entry.source !== model ||
            entry.target !== userModel ||
            (entry as typeof entry & { targetKey?: string }).targetKey !== userModel.primaryKeyAttribute,
        )
      )
        continue;
      fields.set(name, {
        field,
        createOnly: field.options.createOnly === true,
        dataType: field.options.dataType,
        attribute,
        column: attribute.field,
        type: (attribute.type as { key: string }).key,
        references,
      });
    }
    if (!fields.size) return fields;
    // An audit FK cannot double as a business relation key elsewhere in the graph.
    for (const other of db.collections.values())
      for (const entry of Object.values(other.model.associations)) {
        const relation = entry as typeof entry & {
          foreignKey?: string;
          sourceKey?: string;
          targetKey?: string;
          otherKey?: string;
          through?: { model?: typeof model };
        };
        if (relation.source === model && relation.associationType !== 'BelongsTo' && relation.sourceKey)
          fields.delete(relation.sourceKey);
        if (relation.target === model) {
          if (relation.targetKey) fields.delete(relation.targetKey);
          if (!['BelongsTo', 'BelongsToMany'].includes(relation.associationType) && relation.foreignKey)
            fields.delete(relation.foreignKey);
        }
        if (relation.through?.model === model) {
          if (relation.foreignKey) fields.delete(relation.foreignKey);
          if (relation.otherKey) fields.delete(relation.otherKey);
        }
      }
    return fields;
  };
  const selected = discover();
  const currentUser = selected.size && actor.userId != null ? normalizeKeys([actor.userId], users!)[0] : null;
  const sameUser = (value: unknown) =>
    value == null ? currentUser === null : currentUser !== null && normalizeKeys([value], users!)[0] === currentUser;
  return {
    has: (name: string) => selected.has(name),
    assertCurrent() {
      const current = discover();
      if (
        collection.model !== model ||
        db.getCollection(collection.name) !== collection ||
        db.getCollection('users') !== users ||
        users?.model !== userModel ||
        userModel?.primaryKeyAttribute !== userPrimary ||
        userModel?.rawAttributes[userPrimary] !== userAttribute ||
        (userAttribute?.type as { key?: string })?.key !== userType ||
        userAttribute?.field !== userColumn ||
        current.size !== selected.size ||
        [...selected].some(
          ([name, value]) =>
            current.get(name)?.field !== value.field ||
            current.get(name)?.createOnly !== value.createOnly ||
            current.get(name)?.dataType !== value.dataType ||
            current.get(name)?.attribute !== value.attribute ||
            current.get(name)?.column !== value.column ||
            current.get(name)?.type !== value.type ||
            current.get(name)?.references.length !== value.references.length ||
            value.references.some((reference, index) => current.get(name)?.references[index] !== reference),
        )
      )
        invalid('User audit field metadata changed during write');
    },
    acceptsCreate: (_name: string, value: unknown) => sameUser(value),
    acceptsUpdate(name: string, value: unknown, before: unknown) {
      return isDeepStrictEqual(value, before) || (!selected.get(name)!.createOnly && sameUser(value));
    },
  };
}

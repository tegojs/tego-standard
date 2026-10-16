import type { Collection, Database } from '@tego/server';

import { accessMetadataGuard } from './metadata-snapshot';
import { invalid } from './write-support';

interface PermissionNode {
  all: boolean;
  fields: Set<string>;
  children: Map<string, PermissionNode>;
}

/** A permission path limits descendants; it never authorizes a target operation or a relationship fact. */
export function captureReadPermissionPaths(
  db: Database,
  root: Collection,
  appends: readonly string[],
  resolveCollectionKey: (collection: Collection) => string | undefined,
) {
  const node = (): PermissionNode => ({ all: false, fields: new Set(), children: new Map() });
  const tree = node();
  const identities = new Map<Collection, string>();
  const keys = new Map<string, Collection>();
  const paths: Array<{ model: Collection['model']; path: string[] }> = [];
  const capture = (collection: Collection) => {
    if (identities.has(collection)) return;
    const key = resolveCollectionKey(collection);
    if (
      collection.db !== db ||
      db.getCollection(collection.name) !== collection ||
      !key ||
      (keys.has(key) && keys.get(key) !== collection)
    )
      invalid('Read permission path collection identity is unavailable');
    identities.set(collection, key);
    keys.set(key, collection);
  };
  capture(root);
  let nodes = 0;
  for (const value of appends) {
    if (value.length > 1024 || /[()*]/.test(value)) invalid('Read permission paths must use ordinary field names');
    const parts = value.split('.');
    if (parts.length > 4 || parts.some((part) => !part || ['__proto__', 'constructor', '$through'].includes(part)))
      invalid('Read permission paths support at most three association levels');
    let collection = root;
    let current = tree;
    const path: string[] = [];
    for (let index = 0; index < parts.length; index++) {
      const name = parts[index];
      const attribute = Object.hasOwn(collection.model.rawAttributes, name) && collection.model.rawAttributes[name];
      if (attribute) {
        if (!index || index !== parts.length - 1 || (attribute.type as { key?: string }).key === 'VIRTUAL')
          invalid('Read permission appends require associations and physical terminal fields');
        current.fields.add(name);
        break;
      }
      const relation = Object.hasOwn(collection.model.associations, name) && collection.model.associations[name];
      const target = relation && db.modelCollection.get(relation.target);
      if (
        index >= 3 ||
        !relation ||
        !['BelongsTo', 'HasMany', 'HasOne', 'BelongsToMany'].includes(relation.associationType) ||
        !target
      )
        invalid('Read permission contains an unsupported association path');
      capture(target);
      if (!current.children.has(name)) {
        if (++nodes > 100) invalid('Read permission exceeds 100 association paths');
        current.children.set(name, node());
      }
      current = current.children.get(name)!;
      collection = target;
      path.push(name);
      if (index === parts.length - 1) current.all = true;
    }
    paths.push({ model: root.model, path });
  }
  const metadataCurrent = accessMetadataGuard(db, [], paths);
  const assertCurrent = () => {
    metadataCurrent();
    for (const [collection, key] of identities) {
      if (resolveCollectionKey(collection) !== key) invalid('Read permission path identity changed during query');
    }
  };
  assertCurrent();
  return {
    associations: [...tree.children.keys()],
    fieldsAt: (path: readonly string[], fields: readonly string[]): readonly string[] => {
      let current = tree;
      for (const name of path) {
        if (current.all) return fields;
        const child = current.children.get(name);
        if (!child) return [];
        current = child;
      }
      return current.all ? fields : fields.filter((field) => current.fields.has(field) || current.children.has(field));
    },
    assertCurrent,
  };
}

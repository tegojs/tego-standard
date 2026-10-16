import type { Collection, Database } from '@tego/server';

import type { AccessFilterGrantResolver } from './request-filter';
import { invalid, plain } from './write-support';

export interface AccessReadSelection {
  attributes: string[];
  expansions: AccessAssociationSelection[];
}

export interface AccessAssociationSelection extends AccessReadSelection {
  association: string;
}

interface SelectionNode {
  collection: Collection;
  fields: Set<string>;
  all: boolean;
  explicit: boolean;
  except: Set<string>;
  children: Map<string, SelectionNode>;
}

/** Internal selection bridge; never accepts SQL or grants from request parameters. */
export class AccessReadSelectionParser {
  constructor(
    private readonly db: Database,
    private readonly resolveGrant: AccessFilterGrantResolver,
  ) {}

  parse(collection: Collection, request: unknown): AccessReadSelection {
    if (
      collection.db !== this.db ||
      this.db.getCollection(collection.name) !== collection ||
      !plain(request) ||
      Reflect.ownKeys(request).some(
        (key) =>
          typeof key !== 'string' ||
          !['fields', 'appends', 'except'].includes(key) ||
          !Object.hasOwn(Object.getOwnPropertyDescriptor(request, key)!, 'value'),
      )
    )
      invalid('Unsupported read selection');
    // Snapshot every list before invoking server permission resolvers.
    const snapshot = (value: unknown): string[][] | undefined => {
      if (value === undefined) return;
      if (
        !Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Array.prototype ||
        value.length > 1000 ||
        Reflect.ownKeys(value).length !== value.length + 1
      )
        invalid('Selection paths must be a bounded dense list');
      const result: string[][] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (
          !descriptor ||
          !Object.hasOwn(descriptor, 'value') ||
          typeof descriptor.value !== 'string' ||
          !descriptor.value.length ||
          descriptor.value.length > 1024 ||
          /[()*]/.test(descriptor.value)
        )
          invalid('Select registered fields using ordinary association paths');
        const path = descriptor.value.split('.');
        if (path.length > 4 || path.some((part) => !part)) invalid('Select at most three association levels');
        result.push(path);
      }
      return result;
    };
    const fields = snapshot(request.fields);
    const appends = snapshot(request.appends) ?? [];
    const except = snapshot(request.except) ?? [];
    const node = (collection: Collection): SelectionNode => ({
      collection,
      fields: new Set(),
      all: false,
      explicit: false,
      except: new Set(),
      children: new Map(),
    });
    const root = node(collection);
    root.all = fields === undefined;
    root.explicit = fields !== undefined;
    let count = 0;
    const target = (source: Collection, name: string): Collection => {
      const relation = Object.hasOwn(source.model.associations, name) && source.model.associations[name];
      const result = relation && this.db.modelCollection.get(relation.target);
      if (
        !result ||
        result.db !== this.db ||
        this.db.getCollection(result.name) !== result ||
        !['BelongsTo', 'HasMany', 'HasOne', 'BelongsToMany'].includes(relation.associationType) ||
        Object.hasOwn(source.model.rawAttributes, name)
      )
        invalid('Select a registered same-database association');
      return result;
    };
    const physical = (source: Collection, name: string) =>
      Object.hasOwn(source.model.rawAttributes, name) &&
      (source.model.rawAttributes[name].type as { key?: string }).key !== 'VIRTUAL';
    const append = (path: string[], allowRootField: boolean) => {
      let current = root;
      for (let index = 0; index < path.length; index++) {
        const name = path[index];
        if (physical(current.collection, name)) {
          if (index !== path.length - 1 || (!index && !allowRootField))
            invalid('Appends require an association followed by physical fields');
          current.fields.add(name);
          current.explicit = true;
          return;
        }
        if (index >= 3) invalid('Select at most three association levels');
        const collection = target(current.collection, name);
        if (!current.children.has(name)) {
          if (++count > 20) invalid('Select at most 20 association paths');
          current.children.set(name, node(collection));
        }
        current = current.children.get(name)!;
        if (index === path.length - 1) current.all = true;
      }
    };
    for (const path of fields ?? []) append(path, true);
    for (const path of appends) append(path, false);
    for (const path of except) {
      let source = collection;
      let selected: SelectionNode | undefined = root;
      for (let index = 0; index < path.length; index++) {
        const name = path[index];
        if (index === path.length - 1) {
          if (!physical(source, name)) invalid('Except requires a physical field path');
          selected?.except.add(name);
        } else {
          source = target(source, name);
          selected = selected?.children.get(name);
        }
      }
    }
    const select = (selected: SelectionNode, path: readonly string[]): AccessReadSelection => {
      const grant = this.resolveGrant(selected.collection, Object.freeze([...path]));
      if (!grant || grant.identity.collectionName !== selected.collection.name)
        invalid('Read selection is not authorized for this collection');
      if ([...selected.fields, ...selected.children.keys()].some((name) => !grant.fields.includes(name)))
        invalid('Read selection fields or associations are not authorized');
      const defaults = selected.all || !selected.explicit;
      const attributes = defaults
        ? Object.keys(selected.collection.model.rawAttributes).filter(
            (name) => physical(selected.collection, name) && grant.fields.includes(name) && !selected.except.has(name),
          )
        : [...selected.fields];
      const expansions = [...selected.children].map(([association, child]) => ({
        association,
        ...select(child, [...path, association]),
      }));
      if (!attributes.length && !expansions.length) invalid('Select at least one authorized field or association');
      return { attributes, expansions };
    };
    return select(root, []);
  }
}

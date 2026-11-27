import type { Collection, Database } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { AccessTargetForeignKeyMutationHandler } from './has-many-mutation-handler';
import type { AccessQueryService } from './query';
import { AccessReferenceMutationHandler } from './reference-mutation-handler';
import { AccessRootMutationHandler } from './root-mutation-handler';
import type { AccessRootReadContext } from './root-read-context';
import { invalid, plain } from './write-support';

export interface AccessMutationAuthorizers {
  /** Independently finalized neutral root decisions, never the association target decision. */
  read: (collection: Collection) => Promise<AccessRootReadContext | null>;
  update: (collection: Collection) => Promise<AccessRootReadContext | null>;
  source: (collection: Collection, operation: 'add' | 'remove' | 'set') => Promise<AccessRootReadContext | null>;
}

function data(input: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor) return;
  if (!Object.hasOwn(descriptor, 'value')) invalid('Mutation routing cannot contain accessors');
  return descriptor.value;
}

function name(value: string): boolean {
  return (
    value.length <= 255 &&
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) &&
    !['_', '__proto__', 'constructor', 'prototype'].includes(value)
  );
}

/** Internal dispatcher only. Each selected handler retains the full ACL and transaction contract. */
export class AccessResourceMutationHandler {
  private readonly root: AccessRootMutationHandler;
  private readonly references: AccessReferenceMutationHandler;
  private readonly children: AccessTargetForeignKeyMutationHandler;
  private readonly singleChild: AccessTargetForeignKeyMutationHandler;

  constructor(
    private readonly db: Database,
    prepared: AccessAclScopeAdapter,
    queries: AccessQueryService,
    resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  ) {
    this.root = new AccessRootMutationHandler(db, prepared, queries, resolveIdentity);
    this.references = new AccessReferenceMutationHandler(db, prepared, queries, resolveIdentity);
    this.children = new AccessTargetForeignKeyMutationHandler(db, prepared, queries, resolveIdentity);
    this.singleChild = new AccessTargetForeignKeyMutationHandler(db, prepared, queries, resolveIdentity, 'HasOne');
  }

  async handle(
    ctx: AccessRootReadContext,
    actor: AccessIdentity,
    authorizers: AccessMutationAuthorizers,
  ): Promise<void> {
    if (ctx.db !== this.db || !ctx.action || typeof ctx.action !== 'object')
      invalid('Mutation routing database or action is unavailable');
    const resourceName = data(ctx.action, 'resourceName');
    const action = data(ctx.action, 'actionName');
    if (typeof resourceName !== 'string' || resourceName.length > 511 || typeof action !== 'string')
      invalid('Unsupported resource mutation descriptor');
    const parts = resourceName.split('.');
    if (parts.length > 2 || !parts.every(name)) invalid('Unsupported resource mutation name');
    const collection = this.db.collections.get(parts[0]);
    if (!collection || collection.db !== this.db) invalid('Mutation routing collection is unavailable');
    if (parts.length === 2) {
      const relation =
        Object.hasOwn(collection.model.associations, parts[1]) && collection.model.associations[parts[1]];
      if (!relation) invalid('Mutation routing association is unavailable');
      // No /_/ write shortcut: concrete handlers validate the original source and selectors.
      switch (relation.associationType) {
        case 'BelongsToMany':
          return this.references.handleAssociation(ctx, actor, authorizers.source, authorizers.read);
        case 'HasMany':
          return this.children.handle(ctx, actor, authorizers.source, authorizers.update, authorizers.read);
        case 'HasOne':
          return this.singleChild.handle(ctx, actor, authorizers.source, authorizers.update, authorizers.read);
        default:
          invalid('Unsupported concrete association mutation');
      }
    }
    if (action !== 'update') return this.root.handle(ctx, actor, authorizers.read);
    if (!plain(ctx.permission)) invalid('Mutation routing permission is unavailable');
    const raw = data(ctx.permission, 'rawParams');
    if (!plain(raw)) invalid('Mutation routing requires original action parameters');
    const values = data(raw, 'values');
    // Inspect names synchronously without copying inputs. In particular, retain raw array prototypes.
    const names = plain(values)
      ? Reflect.ownKeys(values).filter(
          (key): key is string => typeof key === 'string' && Object.hasOwn(collection.model.associations, key),
        )
      : [];
    if (!names.length) return this.root.handle(ctx, actor, authorizers.read);
    const types = names.map((key) => collection.model.associations[key].associationType);
    if (types.every((type) => ['BelongsTo', 'BelongsToMany'].includes(type)))
      return this.references.handle(ctx, actor, authorizers.read);
    if (types.length === 1 && types[0] === 'HasMany')
      return this.children.handleRoot(ctx, actor, authorizers.update, authorizers.read);
    if (types.length === 1 && types[0] === 'HasOne')
      return this.singleChild.handleRoot(ctx, actor, authorizers.update, authorizers.read);
    // Never retry a rejected/unsupported request through another handler or the old repository path.
    invalid('This combination of association updates requires a dedicated adapter');
  }
}

import type { Collection, Database } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { resolveBelongsTo } from './association-metadata';
import { AccessBelongsToService } from './belongs-to';
import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { captureAccessFilter } from './filter-input';
import { captureFinalActionPermission } from './final-action-permission';
import { accessMetadataGuard } from './metadata-snapshot';
import { AccessMutationService } from './mutation';
import type { AccessQueryService } from './query';
import { AccessReadGrantAdapter } from './read-grants';
import { AccessReferenceService } from './references';
import { AccessRoleFilterCompiler } from './role-filter';
import { captureRelatedReadPermission, type AccessRootReadContext } from './root-read-context';
import { cloneDeep, invalid, normalizeKeys, plain } from './write-support';

function data(input: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor) return;
  if (!Object.hasOwn(descriptor, 'value')) invalid('Reference context cannot contain accessors');
  return descriptor.value;
}

function shape(input: unknown, keys: readonly string[]): asserts input is Record<string, unknown> {
  if (!plain(input) || Reflect.ownKeys(input).some((key) => typeof key !== 'string' || !keys.includes(key)))
    invalid('Unsupported reference mutation parameters');
  for (const key of Reflect.ownKeys(input)) data(input, key);
}

/** Internal root update with exactly one BelongsTo reference; never edits target payloads or registers routes. */
export class AccessBelongsToMutationHandler {
  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly queries: AccessQueryService,
    private readonly resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  ) {}

  async handle(
    ctx: AccessRootReadContext,
    authenticated: AccessIdentity,
    authorizeTarget: (collection: Collection) => Promise<AccessRootReadContext | null>,
  ): Promise<void> {
    if (ctx.db !== this.db || !ctx.action || typeof ctx.action !== 'object' || !plain(authenticated))
      invalid('Reference database or authenticated context is unavailable');
    const resourceName = data(ctx.action, 'resourceName');
    if (
      typeof resourceName !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(resourceName) ||
      ['_', '__proto__', 'constructor', 'prototype'].includes(resourceName) ||
      data(ctx.action, 'actionName') !== 'update' ||
      data(ctx.action, 'sourceId') !== undefined ||
      data(ctx.action, 'resourceOf') !== undefined
    )
      invalid('Only root reference updates are supported');
    const actor = Object.freeze(cloneDeep(authenticated));
    if (typeof actor.roleName !== 'string') invalid('Reference updates require an authenticated role');
    const roleName = actor.roleName;
    const permission = captureFinalActionPermission(ctx.permission, {
      resourceName,
      actionName: 'update',
      roleName: actor.roleName,
    });
    if (!permission.allowed || !plain(ctx.permission)) invalid('Reference update is not authorized');
    const raw = data(ctx.permission, 'rawParams');
    shape(raw, [
      'resourceName',
      'actionName',
      'associatedName',
      'associatedIndex',
      'resourceIndex',
      'filterByTk',
      'values',
    ]);
    const params = cloneDeep(raw);
    for (const [key, expected] of [
      ['resourceName', resourceName],
      ['actionName', 'update'],
      ['associatedName', undefined],
      ['associatedIndex', undefined],
    ] as const)
      if (Object.hasOwn(params, key) && params[key] !== expected)
        invalid('Reference transport metadata does not match');
    if (
      !(
        (typeof params.filterByTk === 'string' && params.filterByTk.length > 0 && params.filterByTk.length <= 255) ||
        (typeof params.filterByTk === 'number' && Number.isSafeInteger(params.filterByTk))
      ) ||
      (params.resourceIndex !== undefined &&
        (!['string', 'number'].includes(typeof params.resourceIndex) ||
          String(params.resourceIndex) !== String(params.filterByTk)))
    )
      invalid('Reference update requires a single matching source key');
    if (!plain(params.values) || Reflect.ownKeys(params.values).length !== 1)
      invalid('Reference updates require exactly one association');
    const name = Reflect.ownKeys(params.values)[0];
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) invalid('Invalid association name');
    const value = data(params.values, name);
    if (value !== null && typeof value !== 'string' && typeof value !== 'number')
      invalid('Reference values must be a target key or null');
    shape(permission.params, ['whitelist', 'blacklist', 'filter', 'own']);
    if (permission.params.own !== undefined && permission.params.own !== false)
      invalid('Own-record mutation permissions must be finalized');
    const names = (input: unknown) => {
      if (input === undefined) return;
      const fields = captureAccessFilter(input);
      if (
        !Array.isArray(fields) ||
        fields.some((field) => typeof field !== 'string') ||
        new Set(fields).size !== fields.length
      )
        invalid('Reference field grants must be distinct field names');
      return fields as string[];
    };
    const whitelist = names(permission.params.whitelist);
    const blacklist = names(permission.params.blacklist);
    const source = this.db.getCollection(resourceName);
    const field = source?.getField(name);
    const association = source?.model.associations[name];
    const target = association && this.db.modelCollection.get(association.target);
    if (!source || !field || !target || field.target !== target.name || association.associationType !== 'BelongsTo')
      invalid('Reference requires a registered BelongsTo field');
    const sourceIdentity = cloneDeep(this.resolveIdentity(source));
    const targetIdentity = cloneDeep(this.resolveIdentity(target));
    if (
      !sourceIdentity ||
      !targetIdentity ||
      sourceIdentity.collectionName !== source.name ||
      targetIdentity.collectionName !== target.name
    )
      invalid('Reference collection identity is unavailable');
    const relation = resolveBelongsTo(
      this.db,
      this.prepared,
      this.queries,
      ctx,
      sourceIdentity,
      targetIdentity,
      name,
      true,
    );
    if (
      (whitelist !== undefined && !whitelist.includes(name)) ||
      blacklist?.includes(name) ||
      blacklist?.includes(relation.foreignKey)
    )
      invalid('Association field is not writable');
    for (const entry of [...(whitelist ?? []), ...(blacklist ?? [])])
      if (!Object.hasOwn(source.model.rawAttributes, entry) && !Object.hasOwn(source.model.associations, entry))
        invalid('Reference permission contains unsupported fields');
    const keys = normalizeKeys([params.filterByTk], source);
    const targetKey = value === null ? null : normalizeKeys([value], target)[0];
    const compiler = new AccessRoleFilterCompiler(this.db, this.resolveIdentity);
    const role = compiler.compile(sourceIdentity, captureAccessFilter(permission.params.filter ?? {}));
    const metadata = accessMetadataGuard(
      this.db,
      [
        { model: source.model, config: relation.sourceConfig },
        { model: target.model, config: relation.targetConfig },
      ],
      [{ model: source.model, path: [name] }],
    );
    let assertTargetCurrent: (() => void) | undefined;
    const assertCurrent = () => {
      relation.current();
      metadata();
      role.assertCurrent();
      assertTargetCurrent?.();
      if (
        source.getField(name) !== field ||
        field.target !== target.name ||
        source.filterTargetKey !== source.model.primaryKeyAttribute
      )
        invalid('Reference source field or locator changed');
      for (const [collection, expected] of [
        [source, sourceIdentity],
        [target, targetIdentity],
      ] as const) {
        const actual = this.resolveIdentity(collection);
        if (
          !actual ||
          actual.collectionName !== expected.collectionName ||
          accessCollectionKey(actual) !== accessCollectionKey(expected)
        )
          invalid('Reference entry identity changed');
      }
    };
    assertCurrent();
    const links = new AccessBelongsToService(
      this.db,
      this.prepared,
      this.queries,
      new AccessMutationService(this.db, this.prepared, this.queries),
      new AccessReferenceService(this.db, this.prepared, this.queries),
    );
    const result = await links.withReference(
      ctx,
      sourceIdentity,
      targetIdentity,
      actor,
      { association: name, sourceKeys: keys, targetKey, sourceWhere: role.rootWhere ?? role.where },
      async (plan) => {
        assertCurrent();
        for (const record of plan.records) {
          await source.repository.update({
            filterByTk: record.getDataValue(source.model.primaryKeyAttribute),
            values: plan.valuesFor(record),
            transaction: plan.transaction,
            context: ctx,
          });
          assertCurrent();
        }
      },
      {
        assertCurrent,
        targetScope: async () => {
          assertCurrent();
          const related = await authorizeTarget(target);
          assertCurrent();
          if (!related) invalid('Reference target is not authorized');
          const decision = captureRelatedReadPermission(this.db, target, roleName, related);
          const plan = new AccessReadGrantAdapter(this.db, (collection) => {
            const resolved = this.resolveIdentity(collection);
            return resolved && accessCollectionKey(resolved);
          }).capturePlan(targetIdentity, decision, compiler);
          if (!plan || !plan.grant.fields.includes(target.model.primaryKeyAttribute))
            invalid('Reference target key is not readable');
          assertTargetCurrent = plan.assertCurrent;
          assertCurrent();
          return { where: plan.grant.where };
        },
      },
    );
    ctx.body = result;
  }
}

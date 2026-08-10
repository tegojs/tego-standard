import { BelongsToManyRepository, HasManyRepository, Op, Repository } from '@tego/server';

import { TENANT_ENABLED_MODES, TENANT_INHERITED_MODE } from '../constants';
import { getCollectionTenancyMode } from './isTenantScopedCollection';
import { applyTenantFilterToContext } from './tenant-filter';

function getTenantId(ctx: any) {
  return ctx.state?.currentTenant?.id ?? ctx.state?.currentTenantId;
}

function buildSequelizeTenantWhere(ctx: any, collection: any) {
  const tenancyMode = getCollectionTenancyMode(collection);
  if (!TENANT_ENABLED_MODES.includes(tenancyMode as any)) {
    return {};
  }

  const tenantId = getTenantId(ctx);
  if (tenantId === undefined || tenantId === null) {
    ctx.throw(403, 'Tenant context is required');
  }

  if (tenancyMode === TENANT_INHERITED_MODE) {
    return {
      tenantId: {
        [Op.in]: [tenantId, ...(ctx.state?.currentTenantDescendantIds || [])],
      },
    };
  }

  return { tenantId };
}

function buildRepositoryOptions(ctx: any, collection: any, options: Record<string, any>) {
  return applyTenantFilterToContext(ctx, collection, 'update', {
    ...options,
    context: ctx,
  });
}

async function findTenantRecord(ctx: any, collection: any, filterByTk: any, transaction: any) {
  const record = await collection.repository.findOne(
    buildRepositoryOptions(ctx, collection, {
      filterByTk,
      transaction,
    }),
  );

  if (!record) {
    ctx.throw(404, 'Record not found in the current tenant');
  }

  return record;
}

async function updateTenantRecord(
  ctx: any,
  collection: any,
  filterByTk: any,
  values: Record<string, any>,
  options: Record<string, any>,
) {
  return collection.repository.update(
    buildRepositoryOptions(ctx, collection, {
      targetCollection: collection.name,
      filterByTk,
      values,
      ...options,
    }),
  );
}

class TenantSortableCollection {
  collection: any;
  field: any;
  fieldName: string;
  scopeKey?: string;

  constructor(collection: any, fieldName = 'sort') {
    this.collection = collection;
    this.field = collection.getField(fieldName);
    if (this.field?.type !== 'sort') {
      throw new Error(`${fieldName} is not a sort field`);
    }

    this.fieldName = this.field.name;
    this.scopeKey = this.field.options?.scopeKey;
  }

  async move(ctx: any, sourceId: any, targetId: any, insertAfter: boolean, transaction: any) {
    const source = await findTenantRecord(ctx, this.collection, sourceId, transaction);
    const target = await findTenantRecord(ctx, this.collection, targetId, transaction);
    const sourceScope = this.scopeKey ? source.get(this.scopeKey) : undefined;
    const targetScope = this.scopeKey ? target.get(this.scopeKey) : undefined;

    if (this.scopeKey && sourceScope !== targetScope) {
      if (this.scopeKey === 'tenantId') {
        ctx.throw(400, 'Tenant ownership cannot be changed by move');
      }

      let targetSort = target.get(this.fieldName);
      if (insertAfter) {
        targetSort += 1;
      }

      await this.collection.model.increment(this.fieldName, {
        where: {
          ...buildSequelizeTenantWhere(ctx, this.collection),
          [this.scopeKey]: { [Op.eq]: targetScope },
          [this.fieldName]: { [Op.gte]: targetSort },
        },
        by: 1,
        silent: true,
        transaction,
      });

      await updateTenantRecord(
        ctx,
        this.collection,
        sourceId,
        {
          [this.scopeKey]: targetScope,
          [this.fieldName]: targetSort,
        },
        {
          silent: false,
          skipSortScopeChangeAppend: true,
          transaction,
        },
      );
      return;
    }

    let targetSort = target.get(this.fieldName);
    const sourceSort = source.get(this.fieldName);
    if (insertAfter) {
      targetSort += 1;
    }

    const movesForward = targetSort > sourceSort;
    const updateCondition = movesForward
      ? { [Op.gt]: sourceSort, [Op.lte]: targetSort }
      : { [Op.lt]: sourceSort, [Op.gte]: targetSort };
    const where: Record<PropertyKey, any> = {
      ...buildSequelizeTenantWhere(ctx, this.collection),
      [this.fieldName]: updateCondition,
    };

    if (this.scopeKey && sourceScope !== undefined && sourceScope !== null) {
      where[this.scopeKey] = { [Op.eq]: sourceScope };
    }

    await this.collection.model.increment(this.fieldName, {
      where,
      by: movesForward ? -1 : 1,
      silent: true,
      transaction,
    });

    await updateTenantRecord(
      ctx,
      this.collection,
      sourceId,
      { [this.fieldName]: targetSort },
      { silent: true, transaction },
    );
  }

  async changeScope(ctx: any, sourceId: any, targetScope: any, method: string | undefined, transaction: any) {
    const source = await findTenantRecord(ctx, this.collection, sourceId, transaction);
    const targetScopeValue = targetScope?.[this.scopeKey as string];

    if (targetScopeValue && source.get(this.scopeKey) !== targetScopeValue) {
      if (this.scopeKey === 'tenantId') {
        ctx.throw(400, 'Tenant ownership cannot be changed by move');
      }

      await updateTenantRecord(
        ctx,
        this.collection,
        sourceId,
        { [this.scopeKey as string]: targetScopeValue },
        { silent: false, transaction },
      );

      if (method === 'prepend') {
        await this.sticky(ctx, sourceId, transaction);
      }
    }
  }

  async sticky(ctx: any, sourceId: any, transaction: any) {
    await updateTenantRecord(ctx, this.collection, sourceId, { [this.fieldName]: 0 }, { silent: true, transaction });
  }
}

/**
 * Executes the database move action with tenant predicates on every read and write.
 */
export async function moveTenantRecords(ctx: any, db: any, resourceName: string) {
  const repository = ctx.action?.sourceId
    ? db.getRepository(resourceName, ctx.action.sourceId)
    : db.getRepository(resourceName);

  if (repository instanceof BelongsToManyRepository) {
    throw new Error("Sorting association as 'belongs-to-many' type is not supported.");
  }

  if (repository instanceof HasManyRepository) {
    const associationField = repository.sourceCollection.getField(repository.associationName);
    if (!associationField.options.sortable) {
      throw new Error(
        `association ${associationField.options.name} in ${repository.sourceCollection.name} is not sortable`,
      );
    }
  }

  const isCollectionRepository = repository instanceof Repository;
  const collection = isCollectionRepository ? repository.collection : repository.targetCollection;
  const requestedSortField = ctx.action.params.sortField;
  const fieldName = isCollectionRepository
    ? requestedSortField === undefined
      ? 'sort'
      : requestedSortField
    : `${repository.association.foreignKey}Sort`;
  const sortableCollection = new TenantSortableCollection(collection, fieldName);
  const { sourceId, targetId, targetScope, sticky, method } = ctx.action.params;

  await collection.model.sequelize.transaction(async (transaction: any) => {
    if (sourceId && targetId) {
      await sortableCollection.move(ctx, sourceId, targetId, method === 'insertAfter', transaction);
    }

    if (sourceId && targetScope) {
      await sortableCollection.changeScope(ctx, sourceId, targetScope, method, transaction);
    }

    if (sourceId && sticky) {
      await sortableCollection.sticky(ctx, sourceId, transaction);
    }
  });
}

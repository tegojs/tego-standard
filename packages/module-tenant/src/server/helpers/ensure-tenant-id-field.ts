import type { Transactionable } from '@tego/server';

import { TENANT_ENABLED_MODES } from '../constants';

function isTenantEnabledMode(mode?: string | null) {
  return TENANT_ENABLED_MODES.includes(mode as any);
}

function isManagedTenantIdField(field: any) {
  if (!field) {
    return false;
  }

  return (
    field.get('type') === 'context' &&
    field.get('dataIndex') === 'state.currentTenant.id' &&
    field.get('createOnly') === true
  );
}

/**
 * Synchronizes the managed tenantId context field with a collection's tenant isolation mode.
 */
export async function ensureTenantIdField(model: any, options: Transactionable = {}) {
  const collectionName = model.get('name');
  const tenancyMode = model.get('tenancy') ?? model.get('options')?.tenancy;
  const fieldsRepository = model.db.getRepository('fields');
  const exists = await fieldsRepository.findOne({
    filter: {
      collectionName,
      name: 'tenantId',
    },
    transaction: options.transaction,
  });

  if (!isTenantEnabledMode(tenancyMode)) {
    if (isManagedTenantIdField(exists)) {
      await exists.remove({
        transaction: options.transaction,
      });
      await fieldsRepository.destroy({
        filter: {
          collectionName,
          name: 'tenantId',
        },
        transaction: options.transaction,
      });
      const collection = model.db.getCollection(collectionName);
      collection.removeField?.('tenantId');
      await model.load({ transaction: options.transaction, resetFields: true });
    }
    return;
  }

  const tenantField = {
    collectionName,
    name: 'tenantId',
    type: 'context',
    dataIndex: 'state.currentTenant.id',
    createOnly: true,
    uiSchema: {
      type: 'string',
      title: 'Tenant ID',
      'x-component': 'Input',
      'x-read-pretty': true,
    },
  };

  if (!exists) {
    await fieldsRepository.create({
      values: tenantField,
      transaction: options.transaction,
    });
  } else if (isManagedTenantIdField(exists)) {
    await exists.update(tenantField, {
      transaction: options.transaction,
    });
  } else {
    const logger = model.db?.app?.logger || model.db?.logger || model.logger;
    logger?.warn?.(
      `Tenant isolation skipped for collection "${collectionName}": existing non-managed tenantId field prevents automatic tenantId setup.`,
    );
    return;
  }

  model.db.getCollection(collectionName).setField('tenantId', tenantField as any);
  await model.load({ transaction: options.transaction });
  await model.db.getCollection(collectionName).sync({
    force: false,
    alter: {
      drop: false,
    },
    transaction: options.transaction,
  } as any);
}

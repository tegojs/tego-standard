import type { Transactionable } from '@tego/server';

const TENANT_ENABLED_MODES = ['tenantScoped', 'tenantInherited'];

function isTenantEnabledMode(mode?: string | null) {
  return TENANT_ENABLED_MODES.includes(mode || '');
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

export async function ensureTenantIdField(model: any, options: Transactionable = {}) {
  const collectionName = model.get('name');
  const fieldsRepository = model.db.getRepository('fields');
  const exists = await fieldsRepository.findOne({
    filter: {
      collectionName,
      name: 'tenantId',
    },
    transaction: options.transaction,
  });

  if (!isTenantEnabledMode(model.get('tenancy'))) {
    if (isManagedTenantIdField(exists)) {
      await fieldsRepository.destroy({
        filter: {
          collectionName,
          name: 'tenantId',
        },
        transaction: options.transaction,
      });
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
  } else {
    await exists.update(tenantField, {
      transaction: options.transaction,
    });
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

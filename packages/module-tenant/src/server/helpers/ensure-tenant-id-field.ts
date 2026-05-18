import type { Transactionable } from '@tego/server';

const TENANT_ENABLED_MODES = ['tenantScoped', 'tenantInherited'];

function isTenantEnabledMode(mode?: string | null) {
  return TENANT_ENABLED_MODES.includes(mode || '');
}

export async function ensureTenantIdField(model: any, options: Transactionable = {}) {
  if (!isTenantEnabledMode(model.get('tenancy'))) {
    return;
  }

  const collectionName = model.get('name');
  const fieldsRepository = model.db.getRepository('fields');
  const exists = await fieldsRepository.findOne({
    filter: {
      collectionName,
      name: 'tenantId',
    },
    transaction: options.transaction,
  });

  if (!exists) {
    await fieldsRepository.create({
      values: {
        collectionName,
        name: 'tenantId',
        type: 'string',
        uiSchema: {
          type: 'string',
          title: 'Tenant ID',
          'x-component': 'Input',
          'x-read-pretty': true,
        },
      },
      transaction: options.transaction,
    });
  }

  await model.load({ transaction: options.transaction });
  await model.db.getCollection(collectionName).sync({
    force: false,
    alter: {
      drop: false,
    },
    transaction: options.transaction,
  } as any);
}

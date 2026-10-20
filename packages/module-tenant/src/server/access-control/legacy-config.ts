import { TENANT_INHERITED_MODE, TENANT_SCOPED_MODE } from '../constants';
import {
  AccessRuleError,
  type AccessCondition,
  type AccessConfig,
  type AccessRule,
  type CollectionMetadata,
} from './types';
import { validateAccessConfig } from './validate';

function ensure(condition: unknown): asserts condition {
  if (!condition) throw new AccessRuleError('INVALID_ACCESS_RULE', 'Invalid effective legacy tenant configuration');
}

/** Converts explicit effective settings only; never reads, saves, or enables a collection. */
export function draftLegacyAccessConfig(input: unknown, collection: CollectionMetadata): AccessConfig {
  ensure(input !== null && typeof input === 'object' && !Array.isArray(input));
  ensure([Object.prototype, null].includes(Object.getPrototypeOf(input)));
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = ['tenancy', 'legacyDataTenantIds', 'allowEditingLegacyData'];
  ensure(Reflect.ownKeys(input).length === keys.length);
  ensure(keys.every((key) => Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key], 'value')));
  const mode: unknown = descriptors.tenancy.value;
  const list: unknown = descriptors.legacyDataTenantIds.value;
  const editable: unknown = descriptors.allowEditingLegacyData.value;
  ensure(mode === 'shared' || mode === TENANT_SCOPED_MODE || mode === TENANT_INHERITED_MODE);
  ensure(typeof editable === 'boolean');
  ensure(Array.isArray(list) && Object.getPrototypeOf(list) === Array.prototype && list.length <= 1000);
  ensure(Reflect.ownKeys(list).length === list.length + 1);
  const ids: string[] = [];
  for (let index = 0; index < list.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(list, String(index));
    ensure(descriptor && Object.hasOwn(descriptor, 'value'));
    const value: unknown = descriptor.value;
    ensure(
      (typeof value === 'string' && value.length > 0 && value.length <= 10000) ||
        (typeof value === 'number' && Number.isSafeInteger(value)),
    );
    ids.push(String(value));
  }

  const baseCondition: AccessCondition =
    mode === 'shared'
      ? { type: 'constant', value: true }
      : mode === TENANT_INHERITED_MODE
        ? {
            type: 'tenantRelation',
            tenant: { type: 'field', path: 'tenantId' },
            relation: 'ancestor',
            includeSelf: true,
          }
        : {
            type: 'compare',
            operator: 'eq',
            left: { type: 'field', path: 'tenantId' },
            right: { type: 'context', path: 'tenant.id' },
          };
  const rules: AccessRule[] = [
    {
      id: 'legacy-mode',
      name: 'Existing tenant access',
      enabled: true,
      category: 'ownership',
      subject: { type: 'constant', value: true },
      condition: baseCondition,
    },
  ];
  // Shared collections ignore legacy-only options and never acquire a managed tenant field.
  if (mode !== 'shared' && ids.length > 0) {
    const legacyRule = (category: 'visibility' | 'ownership'): AccessRule => ({
      id: `legacy-data-${category}`,
      name: category === 'visibility' ? 'Existing legacy data visibility' : 'Legacy data first-edit claim',
      enabled: true,
      category,
      subject: {
        type: 'compare',
        operator: 'in',
        left: { type: 'context', path: 'tenant.id' },
        right: { type: 'literal', value: [...new Set(ids)] },
      },
      condition: { type: 'isNull', operand: { type: 'field', path: 'tenantId' } },
    });
    rules.push(legacyRule('visibility'));
    // G permits an edit, but the mutation service still owns atomic claim and direct-delete rejection.
    if (editable) rules.push(legacyRule('ownership'));
  }
  return validateAccessConfig(
    { schemaVersion: 1, revision: 0, ownership: { enabled: mode !== 'shared' }, rules },
    collection,
  );
}

import { NAMESPACE } from '../../constants';

export const TENANT_ERROR_MESSAGES = {
  tenantSelectionRequired: 'Please select a tenant before continuing.',
  authenticationRequired: 'Please sign in to access tenant data.',
  tenantAccessDenied:
    'You do not have access to the selected tenant. Select an available tenant or contact an administrator.',
  tenantUnavailable:
    'The selected tenant is unavailable or disabled. Select another tenant or contact an administrator.',
  tenantContextRequired:
    'No tenant is selected. Select a tenant and try again. If no tenant is available, contact an administrator.',
  recordUnavailable:
    'This record or a related record is not available in the current tenant. It may belong to another tenant or have been removed.',
  legacyRecordReadOnly:
    'This record is unassigned legacy data and is read-only. Assign it to a tenant before editing or deleting it.',
  tenantOwnershipMove: 'Moving a record cannot change its tenant. Keep the record in the current tenant and try again.',
  parentTenantNotFound:
    'The selected parent tenant does not exist. Refresh the tenant list and select another parent tenant.',
  parentTenantDisabled: 'The selected parent tenant is disabled. Enable it or select another parent tenant.',
  tenantCycle: 'This tenant cannot be moved under itself or one of its descendants.',
  tenantHierarchyTooDeep: 'The tenant hierarchy is too deep. Select a higher-level parent tenant.',
  tenantHasChildren: 'This tenant has child tenants. Move or delete them before deleting this tenant.',
  tenantIsUserDefault: "This tenant is set as a user's default tenant. Reassign those users before deleting it.",
  tenantHasMembers: 'This tenant still has members. Remove all members before deleting it.',
  sortFieldUnavailable: 'The selected sort field is unavailable. Refresh the page or contact an administrator.',
  manyToManySortUnsupported: 'Sorting many-to-many associations is not supported.',
  associationNotSortable: 'This association cannot be sorted. Enable sorting for it and try again.',
} as const;

export type TenantError = keyof typeof TENANT_ERROR_MESSAGES;

export function translateTenantError(ctx: any, error: TenantError) {
  const message = TENANT_ERROR_MESSAGES[error];
  return typeof ctx?.t === 'function' ? ctx.t(message, { ns: NAMESPACE }) : message;
}

export const LOG_TYPE_CREATE = 'create';
export const LOG_TYPE_UPDATE = 'update';
export const LOG_TYPE_DESTROY = 'destroy';

// Security audit event types
export const AUDIT_TYPE_TENANT_ACCESS_DENIED = 'tenant_access_denied';
export const AUDIT_TYPE_TENANT_CROSS_TENANT = 'tenant_cross_tenant_attempt';
export const AUDIT_TYPE_TENANT_BULK_EXPORT = 'tenant_bulk_export_alert';
export const AUDIT_TYPE_TENANT_IMPERSONATION = 'tenant_impersonation';

// Cross-module event name for tenant security violations
export const EVENT_TENANT_SECURITY = 'tenant.securityViolation';

// Bulk export alert threshold (row count)
export const BULK_EXPORT_THRESHOLD = 1000;

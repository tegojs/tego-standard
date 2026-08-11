/** Tenant-specific configurable properties injected by module-tenant. */
export const TENANCY_MODE_OPTIONS = [
  { label: 'Shared collection', value: 'shared' },
  { label: 'Tenant scoped', value: 'tenantScoped' },
  { label: 'Tenant inherited', value: 'tenantInherited' },
] as const;

export type TenancyMode = (typeof TENANCY_MODE_OPTIONS)[number]['value'];

export const tenantConfigurableProperties = {
  tenancy: {
    title: '{{t("Tenancy mode")}}',
    type: 'string',
    name: 'tenancy',
    default: 'shared',
    enum: TENANCY_MODE_OPTIONS.map((option) => ({
      label: `{{t("${option.label}")}}`,
      value: option.value,
    })),
    'x-decorator': 'FormItem',
    'x-component': 'Select',
    description: '{{t("Controls whether records are isolated by the current tenant.")}}',
  },
  legacyDataTenantIds: {
    title: '{{t("Legacy data visible to tenants")}}',
    type: 'array',
    name: 'legacyDataTenantIds',
    'x-decorator': 'FormItem',
    'x-component': 'LegacyDataTenantSelect',
    'x-component-props': {
      mode: 'multiple',
    },
    description: '{{t("Allows selected tenants to read records that do not have a tenant marker.")}}',
    'x-reactions': {
      dependencies: ['tenancy'],
      when: "{{$deps[0] === 'tenantScoped' || $deps[0] === 'tenantInherited'}}",
      fulfill: {
        state: {
          visible: true,
        },
      },
      otherwise: {
        state: {
          value: [],
          visible: false,
        },
      },
    },
  },
};

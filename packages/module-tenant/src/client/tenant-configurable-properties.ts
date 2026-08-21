/** Tenant-specific configurable properties injected by module-tenant. */
export const TENANCY_MODE_OPTIONS = [
  { label: 'Visible to all tenants', value: 'shared' },
  { label: 'Visible only to current tenant', value: 'tenantScoped' },
  { label: 'Visible to current tenant and its parent tenants', value: 'tenantInherited' },
] as const;

export type TenancyMode = (typeof TENANCY_MODE_OPTIONS)[number]['value'];

export const tenantConfigurableProperties = {
  tenancy: {
    title: '{{t("Data visibility")}}',
    type: 'string',
    name: 'tenancy',
    default: 'shared',
    enum: TENANCY_MODE_OPTIONS.map((option) => ({
      label: `{{t("${option.label}")}}`,
      value: option.value,
    })),
    'x-decorator': 'FormItem',
    'x-component': 'Select',
    description: '{{t("Controls data access across tenants.")}}',
  },
  legacyDataTenantIds: {
    title: '{{t("Tenants with access to legacy data")}}',
    type: 'array',
    name: 'legacyDataTenantIds',
    'x-decorator': 'FormItem',
    'x-component': 'LegacyDataTenantSelect',
    'x-component-props': {
      mode: 'multiple',
    },
    description: '{{t("Selected tenants can access legacy records that have no tenant assignment.")}}',
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

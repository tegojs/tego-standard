/** Tenant-specific configurable properties injected by module-tenant. */
export const tenantConfigurableProperties = {
  tenancy: {
    title: '{{t("Tenancy mode")}}',
    type: 'string',
    name: 'tenancy',
    default: 'shared',
    enum: [
      { label: '{{t("Shared collection")}}', value: 'shared' },
      { label: '{{t("Tenant scoped")}}', value: 'tenantScoped' },
      { label: '{{t("Tenant inherited")}}', value: 'tenantInherited' },
    ],
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

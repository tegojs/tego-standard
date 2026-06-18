import { PresetFields } from '../components/PresetFields';

export const defaultConfigurableProperties = {
  title: {
    type: 'string',
    title: '{{ t("Collection display name") }}',
    required: true,
    'x-decorator': 'FormItem',
    'x-component': 'Input',
  },
  name: {
    type: 'string',
    title: '{{t("Collection name")}}',
    required: true,
    'x-disabled': '{{ !createOnly }}',
    'x-decorator': 'FormItem',
    'x-component': 'Input',
    'x-validator': 'uid',
    description:
      "{{t('Randomly generated and can be modified. Support letters, numbers and underscores, must start with an letter.')}}",
  },
  inherits: {
    title: '{{t("Inherits")}}',
    type: 'hasMany',
    name: 'inherits',
    'x-decorator': 'FormItem',
    'x-component': 'Select',
    'x-component-props': {
      mode: 'multiple',
    },
    'x-disabled': '{{ !createOnly }}',
    'x-visible': '{{ enableInherits}}',
    'x-reactions': ['{{useAsyncDataSource(loadCollections, ["file"])}}'],
  },
  category: {
    title: '{{t("Categories")}}',
    type: 'hasMany',
    name: 'category',
    'x-decorator': 'FormItem',
    'x-component': 'Select',
    'x-component-props': {
      mode: 'multiple',
    },
    'x-reactions': ['{{useAsyncDataSource(loadCategories)}}'],
  },
  description: {
    title: '{{t("Description")}}',
    type: 'string',
    name: 'description',
    'x-decorator': 'FormItem',
    'x-component': 'Input.TextArea',
  },
  presetFields: {
    title: '{{t("Preset fields")}}',
    type: 'void',
    'x-decorator': 'FormItem',
    'x-visible': '{{ createOnly }}',
    'x-component': PresetFields,
  },
};

/** Tenant-specific configurable properties, injected by module-tenant plugin. */
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

export type DefaultConfigurableKeys =
  | 'name'
  | 'title'
  | 'inherits'
  | 'category'
  | 'autoGenId'
  | 'createdBy'
  | 'updatedBy'
  | 'createdAt'
  | 'updatedAt'
  | 'sortable'
  | 'description'
  | 'presetFields';

export const getConfigurableProperties = (...keys: DefaultConfigurableKeys[]) => {
  const props = {} as Record<DefaultConfigurableKeys, any>;
  for (const key of keys) {
    if (defaultConfigurableProperties[key]) {
      props[key] = defaultConfigurableProperties[key];
    }
  }
  return props;
};

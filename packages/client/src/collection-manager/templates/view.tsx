import { CollectionTemplate } from '../../data-source/collection-template/CollectionTemplate';
import { PreviewFields } from './components/PreviewFields';
import { PreviewTable } from './components/PreviewTable';
import { getConfigurableProperties } from './properties';

/**
 * View collection template (connect to database view).
 *
 * Tenant isolation boundary:
 * - View collections do NOT support the `tenancy` configuration option.
 * - `dbViews:query` executes raw `SELECT * FROM <view>` with no tenant filtering.
 * - The default ACL (deny-all) prevents non-root/non-admin roles from accessing
 *   this resource. No explicit `acl.deny` is needed, but admins should be aware that
 *   view collections bypass the tenant resource guard entirely.
 * - The underlying database view itself is responsible for any row-level security.
 */
export class ViewCollectionTemplate extends CollectionTemplate {
  name = 'view';
  title = '{{t("Connect to database view")}}';
  order = 4;
  color = 'yellow';
  default = {
    fields: [],
  };
  divider = true;
  configurableProperties = {
    title: {
      type: 'string',
      title: '{{ t("Collection display name") }}',
      required: true,
      'x-decorator': 'FormItem',
      'x-component': 'Input',
    },

    databaseView: {
      title: '{{t("Connect to database view")}}',
      type: 'single',
      required: true,
      'x-decorator': 'FormItem',
      'x-component': 'Select',
      'x-reactions': ['{{useAsyncDataSource(loadDBViews)}}'],
      'x-disabled': '{{ !createOnly }}',
      description: '{{t("VIEW_COLLECTION_TENANT_ISOLATION_WARNING")}}',
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
      'x-reactions': {
        dependencies: ['databaseView'],
        when: '{{isPG}}',
        fulfill: {
          state: {
            initialValue: '{{$deps[0]&&$deps[0].match(/^([^_]+)_(.*)$/)?.[2]}}',
          },
        },
        otherwise: {
          state: {
            value: null,
          },
        },
      },
    },
    schema: {
      type: 'string',
      'x-hidden': true,
      'x-reactions': {
        dependencies: ['databaseView'],
        when: '{{isPG}}',
        fulfill: {
          state: {
            value: "{{$deps[0].split('_')?.[0]}}",
          },
        },
        otherwise: {
          state: {
            value: null,
          },
        },
      },
    },
    viewName: {
      type: 'string',
      'x-hidden': true,
      'x-reactions': {
        dependencies: ['databaseView'],
        when: '{{isPG}}',
        fulfill: {
          state: {
            value: '{{$deps[0].match(/^([^_]+)_(.*)$/)?.[2]}}',
          },
        },
        otherwise: {
          state: {
            value: '{{$deps[0]}}',
          },
        },
      },
    },
    writableView: {
      type: 'boolean',
      'x-content': '{{t("Allow add new, update and delete actions")}}',
      'x-decorator': 'FormItem',
      'x-component': 'Checkbox',
      default: false,
    },
    sources: {
      type: 'array',
      title: '{{ t("Source collections") }}',
      'x-decorator': 'FormItem',
      'x-component': 'Select',
      'x-component-props': {
        multiple: true,
      },
      'x-reactions': ['{{useAsyncDataSource(loadCollections)}}'],
      'x-disabled': true,
    },
    fields: {
      type: 'array',
      'x-component': PreviewFields,
      'x-visible': '{{ createOnly }}',
      'x-reactions': {
        dependencies: ['name'],
        fulfill: {
          schema: {
            'x-component-props': '{{$form.values}}', //任意层次属性都支持表达式
          },
        },
      },
    },
    preview: {
      type: 'object',
      'x-visible': '{{ createOnly }}',
      'x-component': PreviewTable,
      'x-reactions': {
        dependencies: ['name', 'fields'],
        fulfill: {
          schema: {
            'x-component-props': '{{$form.values}}', //任意层次属性都支持表达式
          },
        },
      },
    },

    ...getConfigurableProperties('category', 'description'),
  };
}

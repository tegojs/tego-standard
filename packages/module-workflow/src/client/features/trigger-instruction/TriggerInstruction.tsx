import { css, useCollectionManager_deprecated, useCompile } from '@tachybase/client';
import { useForm } from '@tachybase/schema';
import { ArrayTable } from '@tego/client';

import { VariableOption, WorkflowVariableInput } from '../..';
import { useFlowContext } from '../../FlowContext';
import { tval } from '../../locale';
import { Instruction } from '../../nodes/default-node/interface';
import { getCollectionFieldOptions } from '../../variable';

const useWorkflowTrigger = () => {
  const { workflow } = useFlowContext();

  return {
    filterSync: workflow?.sync,
    filterKey: workflow?.key ? { $ne: workflow?.key } : undefined,
  };
};

/** 节点: 工作流 */
export class TriggerInstruction extends Instruction {
  title = tval('Workflow');
  type = 'trigger-instruction';
  group = 'extended';
  icon = 'NodeIndexOutlined';
  color = '#0a72e9';
  fieldset = {
    sourceArray: {
      type: 'array',
      title: tval('Data source map'),
      description: tval('Data source map'),
      'x-decorator': 'FormItem',
      'x-component': 'ArrayTable',
      items: {
        type: 'object',
        properties: {
          keyName: {
            type: 'void',
            'x-component': 'ArrayTable.Column',
            'x-component-props': {
              title: tval('keyName'),
            },
            properties: {
              keyName: {
                type: 'string',
                name: 'keyName',
                'x-decorator': 'FormItem',
                'x-component': 'Input',
              },
            },
          },
          sourcePath: {
            type: 'void',
            'x-component': 'ArrayTable.Column',
            'x-component-props': {
              title: tval('Property path'),
            },
            properties: {
              sourcePath: {
                type: 'string',
                name: 'sourcePath',
                required: true,
                'x-decorator': 'FormItem',
                'x-component': 'WorkflowVariableInput',
                'x-component-props': {
                  changeOnSelect: true,
                },
              },
            },
          },
          operations: {
            type: 'void',
            'x-component': 'ArrayTable.Column',
            'x-component-props': {
              dataIndex: 'operations',
              fixed: 'right',
              className: css`
                > *:not(:last-child) {
                  margin-right: 0.5em;
                }
                button {
                  padding: 0;
                }
              `,
            },
            properties: {
              remove: {
                type: 'void',
                'x-component': 'ArrayTable.Remove',
              },
            },
          },
        },
      },
      properties: {
        add: {
          type: 'void',
          title: tval('Add property'),
          'x-component': 'ArrayTable.Addition',
          'x-component-props': {
            defaultValue: {},
          },
        },
      },
    },
    workflowKey: {
      type: 'string',
      title: tval('Workflow'),
      name: 'workflowKey',
      'x-decorator': 'FormItem',
      'x-component': 'WorkflowSelect',
      'x-component-props': {
        buttonAction: 'customize:triggerWorkflows',
        noCollection: true,
        label: 'title',
        value: 'key',
      },
      'x-use-component-props': useWorkflowTrigger,
      required: true,
    },
    bindCollection: {
      type: 'boolean',
      title: tval('Bind collection?'),
      'x-decorator': 'FormItem',
      'x-component': 'Radio.Group',
      enum: [
        { label: tval('Yes'), value: true },
        { label: tval('No'), value: false },
      ],
      required: true,
      default: false,
    },
    collection: {
      type: 'string',
      title: tval('Collection'),
      'x-decorator': 'FormItem',
      'x-component': 'DataSourceCollectionCascader',
      required: true,
      'x-reactions': [
        { target: 'changed', effects: ['onFieldValueChange'], fulfill: { state: { value: [] } } },
        { dependencies: ['bindCollection'], fulfill: { state: { visible: '{{!!$deps[0]}}' } } },
      ],
    },
    appends: {
      type: 'array',
      title: tval('Associations to use'),
      description: tval(
        'Please select the associated fields that need to be accessed in subsequent nodes. With more than two levels of to-many associations may cause performance issue, please use with caution.',
      ),
      'x-decorator': 'FormItem',
      'x-component': 'AppendsTreeSelect',
      'x-component-props': {
        multiple: true,
        useCollection() {
          const form = useForm();
          return form.values?.collection;
        },
      },
      'x-reactions': [{ dependencies: ['collection'], fulfill: { state: { visible: '{{!!$deps[0]}}' } } }],
    },
    model: {
      type: 'array',
      title: tval('Properties mapping'),
      description: tval(
        'If the type of query result is object or array of object, could map the properties which to be accessed in subsequent nodes.',
      ),
      'x-decorator': 'FormItem',
      'x-component': 'ArrayTable',
      items: {
        type: 'object',
        properties: {
          path: {
            type: 'void',
            'x-component': 'ArrayTable.Column',
            'x-component-props': {
              title: tval('Property path'),
            },
            properties: {
              path: {
                type: 'string',
                name: 'path',
                required: true,
                'x-decorator': 'FormItem',
                'x-component': 'Input',
              },
            },
          },
          alias: {
            type: 'void',
            'x-component': 'ArrayTable.Column',
            'x-component-props': {
              title: tval('Alias'),
            },
            properties: {
              alias: {
                type: 'string',
                name: 'alias',
                'x-decorator': 'FormItem',
                'x-component': 'Input',
              },
            },
          },
          label: {
            type: 'void',
            'x-component': 'ArrayTable.Column',
            'x-component-props': {
              title: tval('Label'),
            },
            properties: {
              label: {
                type: 'string',
                name: 'label',
                required: true,
                'x-decorator': 'FormItem',
                'x-component': 'Input',
              },
            },
          },
          operations: {
            type: 'void',
            'x-component': 'ArrayTable.Column',
            'x-component-props': {
              dataIndex: 'operations',
              fixed: 'right',
              className: css`
                > *:not(:last-child) {
                  margin-right: 0.5em;
                }
                button {
                  padding: 0;
                }
              `,
            },
            properties: {
              remove: {
                type: 'void',
                'x-component': 'ArrayTable.Remove',
              },
            },
          },
        },
      },
      properties: {
        add: {
          type: 'void',
          title: tval('Add property'),
          'x-component': 'ArrayTable.Addition',
          'x-component-props': {
            defaultValue: {},
          },
        },
      },
    },
  };
  components = {
    ArrayTable,
    WorkflowVariableInput,
  };
  useVariables(node, options): VariableOption {
    const { key, title, config } = node;
    const { types, fieldNames } = options;

    // 如果配置了 model（属性映射），使用 model 作为输出变量
    if (config.model && Array.isArray(config.model) && config.model.length > 0) {
      return {
        [fieldNames.label]: title,
        [fieldNames.value]: key,
        [fieldNames.children]: config.model.map((item) => ({
          [fieldNames.label]: item.label,
          [fieldNames.value]: item.alias || item.path,
        })),
      };
    }

    // 否则，使用原有的集合字段逻辑
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const compile = useCompile();
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const { getCollectionFields } = useCollectionManager_deprecated();
    const [result] = getCollectionFieldOptions({
      appends: [key, ...(config.appends?.map((item) => `${key}.${item}`) || [])],
      ...options,
      fields: [
        {
          collectionName: config.collection,
          name: key,
          type: 'hasOne',
          target: config.collection,
          uiSchema: {
            title,
          },
        },
      ],
      compile,
      getCollectionFields,
    });

    return result;
  }
}

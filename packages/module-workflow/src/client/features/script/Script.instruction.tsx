import { css } from '@tachybase/client';
import { ArrayTable } from '@tego/client';

import { VariableOption, WorkflowVariableInput } from '../..';
import { NAMESPACE_INSTRUCTION_DATA_MAPPING } from '../../../common/constants';
import { tval } from '../../locale';
import { Instruction } from '../../nodes/default-node/interface';
import { ScriptCodeEditor } from './ScriptCodeEditor';
import { SyncRemoteCodeButton } from './SyncRemoteCodeButton';

export class ScriptInstruction extends Instruction {
  title = tval('Data Mapping');
  type = NAMESPACE_INSTRUCTION_DATA_MAPPING;
  group = 'extended';
  icon = 'FunctionOutlined';
  color = '#d93a13';
  isHot = true;
  description = tval('Get specific data from JSON result of any node BY js code or json code;');
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
    type: {
      type: 'string',
      title: tval('type'),
      'x-decorator': 'FormItem',
      'x-component': 'Radio.Group',
      enum: [
        { label: tval('Cloud Component'), value: 'ts' },
        { label: tval('JSONata'), value: 'jsonata' },
      ],
      default: 'ts',
    },
    codeSource: {
      type: 'string',
      title: tval('Code source'),
      'x-decorator': 'FormItem',
      'x-component': 'Radio.Group',
      default: 'local',
      enum: [
        { label: tval('Local code'), value: 'local' },
        { label: tval('Remote code'), value: 'remote' },
      ],
    },
    codeType: {
      type: 'string',
      title: tval('Code type'),
      'x-decorator': 'FormItem',
      'x-component': 'Radio.Group',
      default: 'git',
      enum: [
        { label: tval('CDN'), value: 'cdn' },
        { label: tval('Git'), value: 'git' },
      ],
      'x-reactions': [
        {
          dependencies: ['codeSource'],
          fulfill: {
            state: {
              visible: '{{$deps[0] === "remote"}}',
            },
          },
        },
      ],
    },
    codeUrl: {
      type: 'string',
      title: tval('Code URL'),
      'x-decorator': 'FormItem',
      'x-component': 'Input',
      'x-component-props': {
        placeholder: tval('Code URL placeholder'),
      },
      'x-reactions': [
        {
          dependencies: ['codeSource', 'codeType'],
          fulfill: {
            state: {
              visible: '{{$deps[0] === "remote"}}',
              required: '{{$deps[0] === "remote" && $deps[1] === "git"}}',
            },
            schema: {
              'x-validator':
                '{{$deps[0] === "remote" && $deps[1] === "git" ? [{ required: true, message: tval("Code URL is required for Git") }] : []}}',
            },
          },
        },
      ],
    },
    codeBranch: {
      type: 'string',
      title: tval('Code branch'),
      'x-decorator': 'FormItem',
      'x-component': 'Input',
      'x-component-props': {
        placeholder: tval('Code branch placeholder'),
      },
      default: 'main',
      'x-reactions': [
        {
          dependencies: ['codeSource', 'codeType'],
          fulfill: {
            state: {
              visible: '{{$deps[0] === "remote" && $deps[1] === "git"}}',
            },
          },
        },
      ],
    },
    codePath: {
      type: 'string',
      title: tval('Code path'),
      'x-decorator': 'FormItem',
      'x-component': 'Input',
      'x-component-props': {
        placeholder: tval('Code path placeholder'),
      },
      'x-reactions': [
        {
          dependencies: ['codeSource', 'codeType'],
          fulfill: {
            state: {
              visible: '{{$deps[0] === "remote" && $deps[1] === "git"}}',
            },
          },
        },
      ],
    },
    codeAuthType: {
      type: 'string',
      title: tval('Authentication type'),
      'x-decorator': 'FormItem',
      'x-component': 'Radio.Group',
      default: 'token',
      enum: [
        { label: tval('No authentication'), value: 'none' },
        { label: tval('Bearer Token'), value: 'token' },
        { label: tval('Basic Auth'), value: 'basic' },
      ],
      'x-reactions': [
        {
          dependencies: ['codeSource'],
          fulfill: {
            state: {
              visible: '{{$deps[0] === "remote"}}',
            },
          },
        },
      ],
    },
    codeAuthToken: {
      type: 'string',
      title: tval('Auth token'),
      'x-decorator': 'FormItem',
      'x-component': 'Input.Password',
      'x-component-props': {
        placeholder: tval('Auth token placeholder'),
      },
      'x-reactions': [
        {
          dependencies: ['codeSource', 'codeAuthType'],
          fulfill: {
            state: {
              visible: '{{$deps[0] === "remote" && ($deps[1] === "token" || $deps[1] === "basic")}}',
            },
          },
        },
      ],
    },
    codeAuthUsername: {
      type: 'string',
      title: tval('Auth username'),
      'x-decorator': 'FormItem',
      'x-component': 'Input',
      'x-component-props': {
        placeholder: tval('Auth username placeholder'),
      },
      'x-reactions': [
        {
          dependencies: ['codeSource', 'codeAuthType'],
          fulfill: {
            state: {
              visible: '{{$deps[0] === "remote" && $deps[1] === "basic"}}',
            },
          },
        },
      ],
    },
    syncRemoteCodeButton: {
      type: 'void',
      'x-component': 'SyncRemoteCodeButton',
      'x-reactions': [
        {
          dependencies: ['codeSource', 'codeType', 'codeUrl'],
          fulfill: {
            state: {
              visible: '{{$deps[0] === "remote" && $deps[1] && $deps[2]}}',
            },
          },
        },
      ],
    },
    code: {
      type: 'string',
      title: tval('expression'),
      'x-decorator': 'FormItem',
      'x-component': 'ScriptCodeEditor',
      'x-component-props': {
        defaultLanguage: 'typescript',
        height: '50vh',
        defaultValue: `
import { Context, MagicAttributeModel, Transactionable } from '@tego/server';

export default async function (
  _data,
  {
    httpContext: ctx,
    dbModel: model,
    dbOptions: options,
    transaction,
  }: { httpContext?: Context; dbModel?: MagicAttributeModel; dbOptions?: any } & Transactionable,
) {
  return {};
}
        `.trim(),
      },
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
    SyncRemoteCodeButton,
    ScriptCodeEditor,
  };

  useVariables(node, options): VariableOption {
    const { key, title, config } = node;
    const { types, fieldNames } = options;
    const model = config.model || [];
    const result = {
      [fieldNames.label]: title,
      [fieldNames.value]: key,
      [fieldNames.children]: model.map((item) => ({
        [fieldNames.label]: item.label,
        [fieldNames.value]: item.alias || item.path,
      })),
    };
    return result;
  }
}

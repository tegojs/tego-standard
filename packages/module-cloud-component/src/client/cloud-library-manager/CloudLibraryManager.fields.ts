export const fieldsets = {
  module: {
    type: 'string',
    'x-component': 'CollectionField',
    'x-decorator': 'FormItem',
    'x-collection-field': 'cloudLibraries.module',
    'x-component-props': {},
  },
  name: {
    type: 'string',
    'x-component': 'CollectionField',
    'x-decorator': 'FormItem',
    'x-collection-field': 'cloudLibraries.name',
    'x-component-props': {},
  },
  code: {
    type: 'string',
    'x-component': 'CollectionField',
    'x-decorator': 'FormItem',
    'x-collection-field': 'cloudLibraries.code',
    'x-component-props': {},
    default: `
import React from 'react';
import dayjs from 'dayjs';
import { Button, Card } from 'antd';

export default () => {
  const format = () => {
    return dayjs(new Date()).format('YYYY-MM-DD HH:mm:ss');
  };
  return (
    <Card>
      <Button type="primary">
        Click me!
      </Button>
      <p>{format()}</p>
    </Card>
  );
};
    `.trim(),
  },

  data: {
    type: 'string',
    'x-component': 'CollectionField',
    'x-decorator': 'FormItem',
    'x-collection-field': 'cloudLibraries.data',
    'x-component-props': {
      default: '{}',
    },
  },

  description: {
    type: 'string',
    'x-component': 'CollectionField',
    'x-decorator': 'FormItem',
    'x-collection-field': 'cloudLibraries.description',
    'x-component-props': {},
  },

  enabled: {
    type: 'boolean',
    'x-component': 'CollectionField',
    'x-decorator': 'FormItem',
    'x-collection-field': 'cloudLibraries.enabled',
    'x-component-props': {},
  },

  isServer: {
    type: 'boolean',
    'x-component': 'CollectionField',
    'x-decorator': 'FormItem',
    'x-collection-field': 'cloudLibraries.isServer',
    'x-component-props': {},
  },

  isClient: {
    type: 'boolean',
    'x-component': 'CollectionField',
    'x-decorator': 'FormItem',
    'x-collection-field': 'cloudLibraries.isClient',
    'x-component-props': {},
  },

  clientPlugin: {
    type: 'string',
    'x-component': 'CollectionField',
    'x-decorator': 'FormItem',
    'x-collection-field': 'cloudLibraries.clientPlugin',
    'x-component-props': {},
  },

  serverPlugin: {
    type: 'string',
    'x-component': 'CollectionField',
    'x-decorator': 'FormItem',
    'x-collection-field': 'cloudLibraries.serverPlugin',
    'x-component-props': {},
  },

  component: {
    type: 'string',
    'x-component': 'CollectionField',
    'x-decorator': 'FormItem',
    'x-collection-field': 'cloudLibraries.component',
    'x-component-props': {},
  },

  codeSource: {
    type: 'string',
    'x-component': 'CollectionField',
    'x-decorator': 'FormItem',
    'x-collection-field': 'cloudLibraries.codeSource',
    'x-component-props': {},
    default: 'local',
    enum: [
      { label: '{{t("Local code")}}', value: 'local' },
      { label: '{{t("Remote code")}}', value: 'remote' },
    ],
  },

  codeType: {
    type: 'string',
    'x-component': 'CollectionField',
    'x-decorator': 'FormItem',
    'x-collection-field': 'cloudLibraries.codeType',
    'x-component-props': {},
    default: 'git',
    enum: [
      { label: '{{t("Git")}}', value: 'git' },
      { label: '{{t("CDN")}}', value: 'cdn' },
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
    'x-component': 'CollectionField',
    'x-decorator': 'FormItem',
    'x-collection-field': 'cloudLibraries.codeUrl',
    'x-component-props': {
      placeholder: '{{t("Code URL placeholder")}}',
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
              '{{$deps[0] === "remote" && $deps[1] === "git" ? [{ required: true, message: t("Code URL is required for Git") }] : []}}',
          },
        },
      },
    ],
  },

  gitUrlPreview: {
    type: 'void',
    'x-component': 'GitUrlPreview',
    'x-reactions': [
      {
        dependencies: ['codeSource', 'codeType', 'codeUrl'],
        fulfill: {
          state: {
            visible: '{{$deps[0] === "remote" && $deps[1] === "git" && $deps[2]}}',
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

  codeAuthType: {
    type: 'string',
    'x-component': 'CollectionField',
    'x-decorator': 'FormItem',
    'x-collection-field': 'cloudLibraries.codeAuthType',
    title: '{{t("Authentication type")}}',
    'x-component-props': {},
    default: 'token',
    enum: [
      { label: '{{t("No authentication")}}', value: 'none' },
      { label: '{{t("Bearer Token")}}', value: 'token' },
      { label: '{{t("Basic Auth")}}', value: 'basic' },
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
    'x-component': 'CollectionField',
    'x-decorator': 'FormItem',
    'x-collection-field': 'cloudLibraries.codeAuthToken',
    title: '{{t("Auth token")}}',
    'x-component-props': {
      placeholder: '{{t("Auth token placeholder")}}',
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
    'x-component': 'CollectionField',
    'x-decorator': 'FormItem',
    'x-collection-field': 'cloudLibraries.codeAuthUsername',
    title: '{{t("Auth username")}}',
    'x-component-props': {
      placeholder: '{{t("Auth username placeholder")}}',
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
};

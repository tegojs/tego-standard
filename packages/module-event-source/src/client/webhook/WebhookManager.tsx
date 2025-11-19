import React, { useCallback, useContext, useEffect, useState } from 'react';
import {
  CardItem,
  ExtendCollectionsProvider,
  SchemaComponent,
  TableBlockProvider,
  useActionContext,
  useAPIClient,
  useBlockRequestContext,
  useCollectionRecord,
  useCollectionRecordData,
  useCollections,
  useCompile,
  useDataBlock,
  useDataBlockRequest,
  useDataBlockResource,
  useFormBlockContext,
  useFormBlockProps,
  usePlugin,
  useRecord,
  useTableBlockContext,
  useTranslation,
  withDynamicSchemaProps,
  WorkflowSelect,
} from '@tachybase/client';
import {
  ExecutionLink,
  ExecutionRetryAction,
  executionSchema,
  ExecutionStatusColumn,
  OpenDrawer,
} from '@tachybase/module-workflow/client';
import { action, ISchema, observable, observer, uid, useField, useForm } from '@tachybase/schema';
import { CodeMirror } from '@tego/client';

import { MenuOutlined } from '@ant-design/icons';
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  MouseSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { Alert as AntdAlert, App, Badge, Button, Dropdown, Space, Tabs, Tag, Typography } from 'antd';
import _ from 'lodash';

import ModuleEventSourceClient from '..';
import { lang, tval } from '../locale';
import { useWebhookCategoryContext, WebhookCategoryContext } from '../provider/WebhookCategoriesProvider';
import { dispatchers } from './collections/dispatchers';
import { webhookCategories } from './collections/webhookCategories';
import { AddWebhookCategory } from './components/AddWebhookCategory';
import { EditWebhookCategory } from './components/EditWebookCategory';
import { TypeContainer } from './components/TypeContainer';
import { WorkflowKeyColumn, WorkflowTitleProvider } from './components/WorkflowKeyColumn';

const tag = observable({ value: '', item: {} });

// TODO
export const ExecutionResourceProvider = ({ params, filter = {}, ...others }) => {
  const webhook = useCollectionRecordData();
  const props = {
    ...others,
    params: {
      ...params,
      filter: {
        ...params?.filter,
        key: webhook.workflowKey,
      },
    },
  };

  return <TableBlockProvider {...props} />;
};

export const useTestActionProps = () => {
  const form = useForm();
  const webhook = useCollectionRecordData();
  const resource = useDataBlockResource();
  return {
    async onClick() {
      const res = await resource.test({
        values: {
          body: JSON.parse(form.values.body || '{}'),
          params: JSON.parse(form.values.params || '{}'),
          name: webhook.name,
        },
      });
      alert(JSON.stringify(res.data));
    },
  };
};

export const useCreateFormBlockProps = () => {
  const { form } = useFormBlockProps();
  if (tag.value) {
    form.values.category = [tag.item];
  }
  return {
    form,
  };
};

const properties = {
  name: {
    type: 'string',
    'x-component': 'CollectionField',
    'x-decorator': 'FormItem',
    'x-collection-field': 'webhooks.name',
    'x-component-props': {},
  },
  category: {
    type: 'array',
    'x-component': 'CollectionField',
    'x-decorator': 'FormItem',
    'x-collection-field': 'webhooks.category',
    'x-component-props': {
      multiple: true,
    },
  },
  enabled: {
    type: 'string',
    'x-component': 'CollectionField',
    'x-decorator': 'FormItem',
    'x-collection-field': 'webhooks.enabled',
    'x-component-props': {},
  },
  workflowKey: {
    type: 'string',
    'x-component': 'CollectionField',
    'x-decorator': 'FormItem',
    'x-collection-field': 'webhooks.workflowKey',
  },
  type: {
    type: 'string',
    'x-component': 'CollectionField',
    'x-decorator': 'FormItem',
    'x-collection-field': 'webhooks.type',
  },
  options: {
    type: 'object',
    'x-component': 'CollectionField',
    'x-decorator': 'FormItem',
    'x-reactions': {
      dependencies: ['type'],
      fulfill: {
        schema: {
          'x-component-props': '{{ useTypeOptions($deps[0]) }}',
        },
      },
    },
    'x-collection-field': 'webhooks.options',
  },
  code: {
    type: 'string',
    'x-component': 'CollectionField',
    'x-decorator': 'FormItem',
    'x-decorator-props': {
      tooltip: 'ctx.request\nctx.body\nctx.originalBody (action response data)\nlib.JSON\nlib.Math\nlib.dayjs',
    },
    'x-collection-field': 'webhooks.code',
  },
  effectConfig: {
    title: tval('Effect config'),
    type: 'string',
    'x-component': 'CodeMirror',
    'x-component-props': {
      options: {
        readOnly: true,
      },
    },
    'x-decorator': 'FormItem',
    'x-decorator-props': {
      tooltip: tval('The real effect of the server, not the preset configuration'),
    },
    'x-collection-field': 'webhooks.effectConfig',
  },
  description: {
    'x-component': 'CollectionField',
    'x-decorator': 'FormItem',
  },
};

const createForm: ISchema = {
  type: 'void',
  'x-acl-action-props': {
    skipScopeCheck: true,
  },
  'x-acl-action': 'webhooks:create',
  'x-decorator': 'FormBlockProvider',
  'x-use-decorator-props': 'useCreateFormBlockDecoratorProps',
  'x-decorator-props': {
    dataSource: 'main',
    collection: dispatchers.name,
  },
  'x-component': 'CardItem',
  properties: {
    form: {
      type: 'void',
      'x-component': 'FormV2',
      'x-use-component-props': 'useCreateFormBlockProps',
      properties: {
        actionBar: {
          type: 'void',
          'x-component': 'ActionBar',
          'x-component-props': {
            style: {
              marginBottom: 'var(--tb-spacing)',
            },
          },
          properties: {
            submit: {
              title: '{{t("Submit")}}',
              'x-action': 'submit',
              'x-component': 'Action',
              'x-use-component-props': 'useCreateActionProps',
              'x-component-props': {
                type: 'primary',
                htmlType: 'submit',
              },
              type: 'void',
            },
          },
        },
        ...properties,
      },
    },
  },
};

const editAction: ISchema = {
  type: 'void',
  title: '{{ t("Edit") }}',
  'x-action': 'update',
  'x-component': 'Action.Link',
  'x-component-props': {
    openMode: 'drawer',
    icon: 'EditOutlined',
  },
  'x-decorator': 'ACLActionProvider',
  properties: {
    drawer: {
      type: 'void',
      title: '{{ t("Edit record") }}',
      'x-component': 'Action.Container',
      'x-component-props': {
        className: 'tb-action-popup',
      },
      properties: {
        card: {
          type: 'void',
          'x-acl-action-props': {
            skipScopeCheck: false,
          },
          'x-acl-action': 'webhooks:update',
          'x-decorator': 'FormBlockProvider',
          'x-use-decorator-props': 'useEditFormBlockDecoratorProps',
          'x-decorator-props': {
            action: 'get',
            dataSource: 'main',
            collection: dispatchers,
            params: {
              appends: ['category'],
            },
          },
          'x-component': 'CardItem',
          properties: {
            form: {
              type: 'void',
              'x-component': 'FormV2',
              'x-use-component-props': 'useEditFormBlockProps',
              properties: {
                actionBar: {
                  type: 'void',
                  'x-component': 'ActionBar',
                  'x-component-props': {
                    style: {
                      marginBottom: 'var(--tb-spacing)',
                    },
                  },
                  properties: {
                    submit: {
                      title: '{{ t("Submit") }}',
                      'x-action': 'submit',
                      'x-component': 'Action',
                      'x-use-component-props': 'useUpdateActionProps',
                      'x-component-props': {
                        type: 'primary',
                        htmlType: 'submit',
                      },
                      'x-action-settings': {
                        triggerWorkflows: [],
                        onSuccess: {
                          manualClose: false,
                          redirecting: false,
                          successMessage: '{{t("Updated successfully")}}',
                        },
                        isDeltaChanged: false,
                      },
                      type: 'void',
                    },
                  },
                },
                ...properties,
              },
            },
          },
        },
      },
    },
  },
};

const deleteAction: ISchema = {
  title: '{{ t("Delete") }}',
  'x-action': 'destroy',
  'x-component': 'Action.Link',
  'x-use-component-props': 'useDestroyActionProps',
  'x-component-props': {
    icon: 'DeleteOutlined',
    confirm: {
      title: "{{t('Delete record')}}",
      content: "{{t('Are you sure you want to delete it?')}}",
    },
  },
  'x-action-settings': {
    triggerWorkflows: [],
  },
  'x-decorator': 'ACLActionProvider',
  type: 'void',
};

const testAction: ISchema = {
  type: 'void',
  title: '{{ t("Test") }}',
  'x-action': 'update',
  'x-component': 'Action.Link',
  'x-component-props': {
    openMode: 'drawer',
    icon: 'EditOutlined',
  },
  'x-decorator': 'ACLActionProvider',
  properties: {
    drawer: {
      type: 'void',
      title: '{{ t("Edit record") }}',
      'x-component': 'Action.Container',
      'x-component-props': {
        className: 'tb-action-popup',
      },
      properties: {
        card: {
          type: 'void',
          'x-acl-action-props': {
            skipScopeCheck: false,
          },
          'x-acl-action': 'webhooks:update',
          'x-decorator': 'FormBlockProvider',
          'x-decorator-props': {
            action: 'get',
            dataSource: 'main',
            collection: dispatchers.name,
          },
          'x-component': 'CardItem',
          properties: {
            testForm: {
              type: 'void',
              'x-component': 'FormV2',
              properties: {
                actionBar: {
                  type: 'void',
                  'x-component': 'ActionBar',
                  'x-component-props': {
                    style: {
                      marginBottom: 'var(--tb-spacing)',
                    },
                  },
                  properties: {
                    submit: {
                      title: '{{ t("Submit") }}',
                      'x-action': 'submit',
                      'x-component': 'Action',
                      'x-use-component-props': 'useTestActionProps',
                      'x-component-props': {
                        type: 'primary',
                        htmlType: 'submit',
                      },
                      'x-action-settings': {
                        triggerWorkflows: [],
                        onSuccess: {
                          manualClose: false,
                          redirecting: false,
                          successMessage: '{{t("Updated successfully")}}',
                        },
                        isDeltaChanged: false,
                      },
                      type: 'void',
                    },
                  },
                },
                params: {
                  type: 'string',
                  'x-component': 'CodeMirror',
                  'x-component-props': {
                    defaultValue: '{}',
                  },
                  'x-decorator': 'FormItem',
                  'x-decorator-props': {
                    label: 'query',
                  },
                },
                body: {
                  type: 'string',
                  'x-component': 'CodeMirror',
                  'x-component-props': {
                    defaultValue: '{}',
                  },
                  'x-decorator': 'FormItem',
                  'x-decorator-props': {
                    label: 'body',
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

function Droppable(props) {
  const { isOver, setNodeRef } = useDroppable({
    id: props.id,
    data: props.data,
  });
  const style = isOver
    ? {
        color: 'green',
      }
    : undefined;

  return (
    <div ref={setNodeRef} style={style}>
      {props.children}
    </div>
  );
}

function Draggable(props) {
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: props.id,
    data: props.data,
  });
  return (
    <div ref={setNodeRef} {...listeners} {...attributes}>
      <div>{props.children}</div>
    </div>
  );
}

const TabTitle = observer(
  ({ item }: { item: any }) => {
    return (
      <Droppable id={item.id.toString()} data={item}>
        <div>
          <Draggable id={item.id.toString()} data={item}>
            <TabBar item={item} />
          </Draggable>
        </div>
      </Droppable>
    );
  },
  { displayName: 'TabTitle' },
);

const WebhooksTabTableBlockProvider = observer((props) => {
  const requestProps = {
    collection: dispatchers,
    dataSource: 'main',
    action: 'list',
    params: {
      pageSize: 20,
      appends: ['updatedBy', 'category'],
      sort: ['-createdAt'],
      filter: {},
    },
    rowKey: 'id',
    showIndex: true,
    dragSort: false,
  };
  if (tag.value) {
    requestProps.params.filter['category.id'] = [tag.value];
  }
  return <TableBlockProvider {...props} {...requestProps} />;
});

const TabBar = ({ item }) => {
  const { t } = useTranslation();
  const compile = useCompile();
  return (
    <Space>
      <Badge color={item.color} />
      {t(compile(item.name))}
    </Space>
  );
};

const DndProvider = observer(
  (props) => {
    const [activeTab, setActiveId] = useState(null);
    const { refresh } = useWebhookCategoryContext();
    const api = useAPIClient();
    const onDragEnd = async (props: DragEndEvent) => {
      const { active, over } = props;
      setTimeout(() => {
        setActiveId(null);
      });
      if (over && over.id !== active.id) {
        await api.resource('webhookCategories').move({
          sourceId: active.id,
          targetId: over.id,
        });
        refresh();
      }
    };

    function onDragStart(event) {
      setActiveId(event.active?.data.current);
    }

    const mouseSensor = useSensor(MouseSensor, {
      activationConstraint: {
        distance: 10,
      },
    });
    const sensors = useSensors(mouseSensor);
    return (
      <DndContext sensors={sensors} onDragEnd={onDragEnd} onDragStart={onDragStart}>
        {props.children}
        <DragOverlay>
          {activeTab ? <span style={{ whiteSpace: 'nowrap' }}>{<TabBar item={activeTab} />}</span> : null}
        </DragOverlay>
      </DndContext>
    );
  },
  { displayName: 'DndProvider' },
);

const WebhooksTabaCardItem = ({ children }) => {
  const api = useAPIClient();
  const [dataSource, setDataSource] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeKey, setActiveKey] = useState({ tab: tag.value, item: tag.item });
  const compile = useCompile();
  const { modal } = App.useApp();

  const fetchData = useCallback(async () => {
    setLoading(true);
    const { data } = await api.request({
      url: 'webhookCategories:list',
      params: {
        paginate: false,
        sort: 'sort',
      },
    });
    setDataSource(data.data);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const remove = (key: any) => {
    modal.confirm({
      title: compile("{{t('Delete category')}}"),
      content: compile("{{t('Are you sure you want to delete it?')}}"),
      onOk: async () => {
        await api.resource('webhookCategories').destroy({
          filter: {
            id: key,
          },
        });
        setActiveKey({ tab: '', item: {} });
        tag.value = '';
        tag.item = {};
        fetchData();
      },
    });
  };

  const menu = _.memoize((item) => {
    return {
      items: [
        {
          key: 'edit',
          label: (
            <SchemaComponent
              schema={{
                type: 'void',
                properties: {
                  [uid()]: {
                    'x-component': 'EditWebhookCategory',
                    'x-component-props': {
                      item: item,
                    },
                  },
                },
              }}
            />
          ),
        },
        {
          key: 'delete',
          label: compile("{{t('Delete category')}}"),
          onClick: () => remove(item.id),
        },
      ],
    };
  });
  return (
    <WebhookCategoryContext.Provider
      value={{
        refresh: fetchData,
        activeKey: activeKey.tab,
        setActiveKey: (key: string) => setActiveKey({ tab: key, item: dataSource.find((value) => value.id === key) }),
      }}
    >
      <DndProvider>
        <Tabs
          addIcon={
            <SchemaComponent
              schema={{
                type: 'void',
                properties: {
                  addCategories: {
                    type: 'void',
                    title: '{{ t("Add category") }}',
                    'x-component': 'AddWebhookCategory',
                    'x-component-props': {
                      type: 'primary',
                    },
                  },
                },
              }}
            />
          }
          type="editable-card"
          activeKey={activeKey.tab}
          onChange={(value) => {
            const item = dataSource.find((data) => data.id === value);
            setActiveKey({ tab: value, item });
            tag.value = value;
            tag.item = item;
            if (value === '') {
              fetchData();
            }
          }}
          defaultActiveKey={activeKey.tab || ''}
          destroyInactiveTabPane={true}
          tabBarStyle={{ marginBottom: '0px' }}
          items={[
            {
              id: '',
              name: lang('All'),
              closable: false,
            },
          ]
            .concat(dataSource)
            .filter((item) => item && item.name != null && item.id != null)
            .map((item) => {
              return {
                label:
                  item.id !== '' ? (
                    <div data-no-dnd="true">
                      <TabTitle item={item} />
                    </div>
                  ) : (
                    compile(item.name)
                  ),
                key: item.id,
                closable: item.closable,
                closeIcon: (
                  <Dropdown menu={menu(item)}>
                    <MenuOutlined
                      role="button"
                      aria-label={compile(item.name)}
                      style={{ padding: 8, margin: '-8px' }}
                    />
                  </Dropdown>
                ),
                children: (
                  <CardItem>
                    <WorkflowTitleProvider>{children}</WorkflowTitleProvider>
                  </CardItem>
                ),
              };
            })}
        />
      </DndProvider>
    </WebhookCategoryContext.Provider>
  );
};

const schema: ISchema = {
  type: 'void',
  properties: {
    provider: {
      type: 'void',
      'x-decorator': WebhooksTabTableBlockProvider,
      'x-component': WebhooksTabaCardItem,
      properties: {
        actions: {
          type: 'void',
          'x-component': 'ActionBar',
          'x-component-props': {
            style: {
              marginBottom: 'var(--tb-spacing)',
            },
          },
          properties: {
            filter: {
              type: 'void',
              title: '{{ t("Filter") }}',
              default: {
                $and: [{ name: { $includes: '' } }],
              },
              'x-action': 'filter',
              'x-component': 'Filter.Action',
              'x-use-component-props': 'useFilterActionProps',
              'x-component-props': {
                icon: 'FilterOutlined',
              },
              'x-align': 'left',
            },
            fuzzySearch: {
              type: 'void',
              'x-component': 'FuzzySearchInput',
              'x-align': 'left',
            },
            refresh: {
              type: 'void',
              title: '{{ t("Refresh") }}',
              'x-component': 'Action',
              'x-component-props': {
                icon: 'ReloadOutlined',
              },
              'x-use-component-props': 'useRefreshActionProps',
            },
            create: {
              type: 'void',
              'x-action': 'create',
              'x-acl-action': 'create',
              title: "{{t('Add new')}}",
              'x-component': 'Action',
              'x-decorator': 'ACLActionProvider',
              'x-component-props': {
                openMode: 'drawer',
                type: 'primary',
                component: 'CreateRecordAction',
                icon: 'PlusOutlined',
              },
              'x-align': 'right',
              'x-acl-action-props': {
                skipScopeCheck: true,
              },
              properties: {
                drawer: {
                  type: 'void',
                  title: '{{ t("Add record") }}',
                  'x-component': 'Action.Container',
                  'x-component-props': {
                    className: 'tb-action-popup',
                  },
                  properties: {
                    form: createForm,
                  },
                },
              },
            },
          },
        },
        alert: {
          type: 'void',
          'x-component': 'Alert',
          'x-use-component-props': 'useShowAlertProps',
          'x-component-props': {
            message: tval(
              'configuration has changed, please click the restart in the upper right corner, or configure the service with EVENT_SOURCE_REALTIME=1 to start in real time',
            ),
            type: 'warning',
            showIcon: true,
          },
        },
        table: {
          type: 'array',
          'x-component': 'TableV2',
          'x-use-component-props': 'useTableBlockProps',
          'x-component-props': {
            rowKey: 'id',
            rowSelection: {
              type: 'checkbox',
            },
          },
          properties: {
            nameColumn: {
              type: 'void',
              'x-decorator': 'TableV2.Column.Decorator',
              'x-component': 'TableV2.Column',
              'x-component-props': {
                width: 50,
                sorter: true,
              },
              properties: {
                name: {
                  'x-collection-field': 'webhooks.name',
                  'x-component': 'CollectionField',
                  'x-component-props': {
                    ellipsis: true,
                  },
                  'x-read-pretty': true,
                  'x-decorator': null,
                  'x-decorator-props': {
                    labelStyle: {
                      display: 'none',
                    },
                  },
                },
              },
            },
            category: {
              type: 'void',
              'x-decorator': 'TableV2.Column.Decorator',
              'x-component': 'TableV2.Column',
              'x-component-props': {
                sorter: true,
                width: 20,
                align: 'center',
              },
              properties: {
                category: {
                  type: 'array',
                  'x-collection-field': 'webhooks.category',
                  'x-component': 'CollectionField',
                  'x-component-props': {
                    multiple: true,
                    mode: 'Tag',
                  },
                  'x-read-pretty': true,
                },
              },
            },
            enabledColumn: {
              type: 'void',
              'x-decorator': 'TableV2.Column.Decorator',
              'x-component': 'TableV2.Column',
              'x-component-props': {
                width: 20,
              },
              properties: {
                enabled: {
                  type: 'boolean',
                  'x-collection-field': 'webhooks.enabled',
                  'x-component': 'CollectionField',
                  'x-component-props': {
                    ellipsis: true,
                  },
                  'x-read-pretty': true,
                  'x-decorator': null,
                  'x-decorator-props': {
                    labelStyle: {
                      display: 'none',
                    },
                  },
                },
              },
            },
            workflowKeyColumn: {
              title: tval('Workflow'),
              type: 'void',
              'x-decorator': 'TableV2.Column.Decorator',
              'x-component': 'TableV2.Column',
              'x-component-props': {
                width: 20,
              },
              properties: {
                workflowKey: {
                  type: 'string',
                  'x-component': 'WorkflowKeyColumn',
                  'x-decorator': 'OpenDrawer',
                  'x-decorator-props': {
                    component: ({ onClick }) => {
                      return <WorkflowKeyColumn onClick={onClick} />;
                    },
                  },
                  properties: {
                    drawer: executionSchema,
                  },
                },
              },
            },
            typeColumn: {
              type: 'void',
              'x-decorator': 'TableV2.Column.Decorator',
              'x-component': 'TableV2.Column',
              'x-component-props': {
                width: 20,
                sorter: true,
              },
              properties: {
                type: {
                  'x-collection-field': 'webhooks.type',
                  'x-component': 'CollectionField',
                  'x-component-props': {},
                  'x-read-pretty': true,
                  'x-decorator': null,
                  'x-decorator-props': {
                    labelStyle: {
                      display: 'none',
                    },
                  },
                },
              },
            },
            effectColumn: {
              type: 'void',
              'x-decorator': 'TableV2.Column.Decorator',
              'x-component': 'TableV2.Column',
              'x-component-props': {
                width: 20,
                sorter: true,
              },
              properties: {
                effect: {
                  type: 'boolean',
                  'x-collection-field': 'webhooks.effect',
                  'x-component': 'CollectionField',
                  'x-component-props': {
                    ellipsis: true,
                  },
                  'x-read-pretty': true,
                  'x-decorator': null,
                  'x-decorator-props': {
                    labelStyle: {
                      display: 'none',
                    },
                  },
                },
              },
            },
            description: {
              type: 'void',
              'x-decorator': 'TableV2.Column.Decorator',
              'x-component': 'TableV2.Column',
              properties: {
                description: {
                  type: 'string',
                  'x-component': 'CollectionField',
                  'x-read-pretty': true,
                },
              },
            },
            updatedAt: {
              type: 'void',
              'x-decorator': 'TableV2.Column.Decorator',
              'x-component': 'TableV2.Column',
              'x-component-props': {
                sorter: true,
                width: 20,
                align: 'center',
                style: {
                  display: 'grid',
                  placeItems: 'center',
                },
              },
              properties: {
                updatedAt: {
                  type: 'string',
                  'x-component': 'CollectionField',
                  'x-read-pretty': true,
                },
              },
            },
            updatedBy: {
              type: 'void',
              'x-decorator': 'TableV2.Column.Decorator',
              'x-component': 'TableV2.Column',
              'x-component-props': {
                sorter: true,
                width: 20,
                align: 'center',
                style: {
                  display: 'grid',
                  placeItems: 'center',
                },
              },
              properties: {
                updatedBy: {
                  type: 'string',
                  'x-collection-field': 'webhooks.updatedBy',
                  'x-component': 'CollectionField',
                  'x-read-pretty': true,
                },
              },
            },
            actionColumn: {
              type: 'void',
              title: '{{ t("Actions") }}',
              'x-decorator': 'TableV2.Column.ActionBar',
              'x-component': 'TableV2.Column',
              'x-component-props': {
                width: 150,
                fixed: 'right',
              },
              'x-action-column': 'actions',
              properties: {
                space: {
                  type: 'void',
                  'x-component': 'Space',
                  properties: {
                    editAction,
                    deleteAction,
                    testAction,
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

const useShowAlertProps = (props) => {
  const service: any = useDataBlockRequest();
  const isChanged = service?.data?.meta?.changed;

  return {
    style: {
      ...props.style,
      visibility: isChanged ? 'visible' : 'hidden',
    },
  };
};

export const WebhookManager = () => {
  const plugin = usePlugin(ModuleEventSourceClient);
  const typeList = [];
  for (const type of plugin.triggers.getKeys()) {
    typeList.push({
      label: plugin.triggers.get(type).title,
      description: plugin.triggers.get(type).description,
      value: type,
    });
  }

  const useTypeOptions = (type) => {
    return {
      options: plugin.triggers?.get(type)?.options,
    };
  };

  const useTriggersOptions = () => {
    const compile = useCompile();
    const result = Array.from(plugin.triggers.getEntities())
      .map(([value, { title, ...options }]) => ({
        value,
        label: compile(title),
        color: 'gold',
        options,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return result;
  };

  return (
    <ExtendCollectionsProvider collections={[dispatchers, webhookCategories]}>
      <SchemaComponent
        name="eventSource"
        schema={schema}
        scope={{
          useTestActionProps,
          useTriggersOptions,
          useTypeOptions,
          ExecutionRetryAction,
          useShowAlertProps,
          useWebhookCategoryContext,
          useCreateFormBlockProps,
        }}
        components={{
          Alert: withDynamicSchemaProps(AntdAlert),
          ExecutionStatusColumn,
          ExecutionResourceProvider,
          OpenDrawer,
          ExecutionLink,
          WorkflowSelect,
          CodeMirror,
          TypeContainer,
          AddWebhookCategory,
          EditWebhookCategory,
          WorkflowKeyColumn,
        }}
      />
    </ExtendCollectionsProvider>
  );
};

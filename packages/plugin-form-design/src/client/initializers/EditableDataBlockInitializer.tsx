import { useCallback, useMemo, useState } from 'react';
import {
  DataBlockInitializerProps,
  SchemaInitializerItem,
  SchemaInitializerMenu,
  useAPIClient,
  useCollectionDataSourceItems,
  useCollectionManager_deprecated,
  useCompile,
  useGetSchemaInitializerMenuItems,
  useMenuSearch,
  useSchemaInitializer,
  useSchemaTemplateManager,
} from '@tachybase/client';
import { uid } from '@tachybase/schema';

import Icon, { TableOutlined } from '@ant-design/icons';
import { cloneDeep } from 'lodash';

import { useTranslation } from '../locale';

export const EditableDataBlockInitializer = (props: DataBlockInitializerProps) => {
  const {
    templateWrap,
    onCreateBlockSchema,
    componentType,
    icon = TableOutlined,
    name,
    title,
    filter,
    onlyCurrentDataSource,
    hideSearch,
    showAssociationFields,
    hideChildrenIfSingleCollection,
    filterDataSource,
    items: itemsFromProps,
    fromOthersInPopup,
    hideOtherRecordsInPopup,
  } = props;
  const api = useAPIClient();
  const { getTemplate, templates: collectionTemplates, refreshCM } = useCollectionManager_deprecated();
  const { t } = useTranslation();
  const { insert, setVisible } = useSchemaInitializer();
  const compile = useCompile();
  const { getTemplateSchemaByMode } = useSchemaTemplateManager();
  const onClick = useCallback(
    async ({ item }) => {
      if (item.template) {
        const s = await getTemplateSchemaByMode(item);
        templateWrap ? insert(templateWrap(s, { item, fromOthersInPopup })) : insert(s);
      } else {
        if (onCreateBlockSchema) {
          onCreateBlockSchema({ item, fromOthersInPopup });
        }
      }
      setVisible(false);
    },
    [fromOthersInPopup, getTemplateSchemaByMode, insert, onCreateBlockSchema, setVisible, templateWrap],
  );
  const items =
    itemsFromProps ||
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useCollectionDataSourceItems({
      componentName: componentType,
      filter,
      filterDataSource,
      onlyCurrentDataSource,
      showAssociationFields,
      dataBlockInitializerProps: props,
      hideOtherRecordsInPopup,
    });
  const getMenuItems = useGetSchemaInitializerMenuItems(onClick);
  const childItems = useMemo(() => {
    return getMenuItems(items, name);
  }, [getMenuItems, items, name]);
  const [openMenuKeys, setOpenMenuKeys] = useState([]);
  const searchedChildren = useMenuSearch({ data: childItems, openKeys: openMenuKeys, hideSearch });
  const collectionItems = useMemo(() => {
    const skipNames = new Set(['sql', 'view', 'import', 'importXlsx']);
    return collectionTemplates
      .filter((item) => !skipNames.has(item.name) && !item.divider)
      .map((item) => {
        return {
          label: compile(item.title),
          key: item.name,
          onClick: async (info) => {
            const schema = getTemplate(info.key);
            const initialValue: any = {
              name: `t_${uid()}`,
              title: "{{t('Untitle collection')}}",
              template: schema.name,
              autoGenId: true,
              createdAt: true,
              createdBy: true,
              updatedAt: true,
              updatedBy: true,
              view: false,
              ...(() => {
                const defaultValue = cloneDeep(schema.default) || {};
                const existingFields = Array.isArray(defaultValue.fields) ? defaultValue.fields : [];
                return {
                  ...defaultValue,
                  fields: [...existingFields, ...systemFields],
                };
              })(),
            };
            await api.resource('collections').create({
              values: {
                logging: true,
                ...initialValue,
              },
            });
            setVisible(false);
            await refreshCM();
            if (onCreateBlockSchema) {
              onCreateBlockSchema({
                item: { name: initialValue.name, dataSource: 'main', title: initialValue.title },
                fromOthersInPopup,
              });
            }
          },
        };
      });
  }, [collectionTemplates]);
  const compiledMenuItems = useMemo(() => {
    let children = searchedChildren.filter((item) => item.key !== 'search' && item.key !== 'empty');
    if (hideChildrenIfSingleCollection && children.length === 1) {
      // 只有一项可选时，直接展开
      children = children[0].children;
    } else {
      children = searchedChildren;
    }
    if (name === 'formDesign' && !onlyCurrentDataSource) {
      children = [
        {
          key: 'create-collection',
          label: t('Create collection'),
          children: collectionItems,
        },
        ...children,
      ];
    }
    return [
      {
        key: name,
        label: compile(title),
        icon: typeof icon === 'string' ? <Icon type={icon as string} /> : (icon as React.ReactNode),
        onClick: (info) => {
          if (info.key !== name) return;
          onClick({ ...info, item: props });
        },
        children,
      },
    ];
  }, [searchedChildren, hideChildrenIfSingleCollection, name, compile, title, icon, onClick, props]);

  if (childItems.length > 1 || (childItems.length === 1 && childItems[0].children?.length > 0)) {
    return (
      <SchemaInitializerMenu
        onOpenChange={(keys) => {
          setOpenMenuKeys(keys);
        }}
        items={compiledMenuItems}
      />
    );
  }

  return <SchemaInitializerItem {...props} onClick={onClick} />;
};

const systemFields = [
  {
    name: 'id',
    type: 'bigInt',
    autoIncrement: true,
    primaryKey: true,
    allowNull: false,
    uiSchema: {
      type: 'number',
      title: '{{t("ID")}}',
      'x-component': 'InputNumber',
      'x-read-pretty': true,
    },
    interface: 'integer',
  },
  {
    name: 'createdAt',
    interface: 'createdAt',
    type: 'date',
    field: 'createdAt',
    uiSchema: {
      type: 'datetime',
      title: '{{t("Created at")}}',
      'x-component': 'DatePicker',
      'x-component-props': {},
      'x-read-pretty': true,
    },
  },
  {
    name: 'createdBy',
    interface: 'createdBy',
    type: 'belongsTo',
    target: 'users',
    foreignKey: 'createdById',
    uiSchema: {
      type: 'object',
      title: '{{t("Created by")}}',
      'x-component': 'AssociationField',
      'x-component-props': {
        fieldNames: {
          value: 'id',
          label: 'nickname',
        },
      },
      'x-read-pretty': true,
    },
  },
  {
    type: 'date',
    field: 'updatedAt',
    name: 'updatedAt',
    interface: 'updatedAt',
    uiSchema: {
      type: 'string',
      title: '{{t("Last updated at")}}',
      'x-component': 'DatePicker',
      'x-component-props': {},
      'x-read-pretty': true,
    },
  },
  {
    type: 'belongsTo',
    target: 'users',
    foreignKey: 'updatedById',
    name: 'updatedBy',
    interface: 'updatedBy',
    uiSchema: {
      type: 'object',
      title: '{{t("Last updated by")}}',
      'x-component': 'AssociationField',
      'x-component-props': {
        fieldNames: {
          value: 'id',
          label: 'nickname',
        },
      },
      'x-read-pretty': true,
    },
  },
];

import { useMemo } from 'react';
import {
  Icon,
  SchemaInitializerItem,
  SchemaInitializerItemType,
  useAPIClient,
  useCollectionManager_deprecated,
  useCompile,
  useSchemaInitializer,
} from '@tachybase/client';
import { uid } from '@tachybase/utils/client';

import { cloneDeep } from 'lodash';

import { featureNameLowerCase_formDesign } from '../constants';
import { tval } from '../locale';

export const formDesignInitializerItem: SchemaInitializerItemType = {
  type: 'subMenu',
  name: featureNameLowerCase_formDesign,
  title: tval('Form design'),
  icon: <Icon type="FormOutlined" />,
  useChildren: useFormDesignItems,
};

function useFormDesignItems(): SchemaInitializerItemType[] {
  const { getTemplate, templates: collectionTemplates, refreshCM } = useCollectionManager_deprecated();
  const compile = useCompile();
  const api = useAPIClient();
  const { insert, setVisible } = useSchemaInitializer();

  const collectionItems = useMemo(() => {
    const skipNames = new Set(['sql', 'view', 'import', 'importXlsx']);
    return collectionTemplates
      .filter((item) => !skipNames.has(item.name) && !item.divider)
      .map((item) => {
        return {
          type: 'item',
          name: item.name,
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
            // if (onCreateBlockSchema) {
            //   onCreateBlockSchema({
            //     item: { name: initialValue.name, dataSource: 'main', title: initialValue.title },
            //     fromOthersInPopup,
            //   });
            // }
          },
        };
      });
  }, [collectionTemplates]);

  return collectionItems;
}
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

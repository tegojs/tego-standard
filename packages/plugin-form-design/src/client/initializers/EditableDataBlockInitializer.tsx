import { useCallback, useMemo, useState } from 'react';
import {
  DataBlockInitializerProps,
  SchemaInitializerItem,
  SchemaInitializerMenu,
  useCollectionDataSourceItems,
  useCompile,
  useGetSchemaInitializerMenuItems,
  useMenuSearch,
  useSchemaInitializer,
  useSchemaTemplateManager,
} from '@tachybase/client';

import Icon, { TableOutlined } from '@ant-design/icons';

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
  const compiledMenuItems = useMemo(() => {
    let children = searchedChildren.filter((item) => item.key !== 'search' && item.key !== 'empty');
    if (hideChildrenIfSingleCollection && children.length === 1) {
      // 只有一项可选时，直接展开
      children = children[0].children;
    } else {
      children = searchedChildren;
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

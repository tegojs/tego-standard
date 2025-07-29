import { useCallback } from 'react';
import {
  Collection,
  CollectionFieldOptions,
  DataBlockInitializer,
  useCreateFormBlock,
  useSchemaInitializerItem,
} from '@tachybase/client';

import { FormOutlined } from '@ant-design/icons';

export const EditableFormBlockInitializer = ({
  filterCollections,
  onlyCurrentDataSource,
  hideSearch,
  createBlockSchema,
  componentType = 'FormItem',
  templateWrap: customizeTemplateWrap,
  showAssociationFields,
  hideChildrenIfSingleCollection,
  hideOtherRecordsInPopup,
  currentText,
  otherText,
}: {
  filterCollections: (options: { collection?: Collection; associationField?: CollectionFieldOptions }) => boolean;
  onlyCurrentDataSource: boolean;
  hideSearch?: boolean;
  createBlockSchema?: (options: any) => any;
  /**
   * 虽然这里的命名现在看起来比较奇怪，但为了兼容旧版本的 template，暂时保留这个命名。
   */
  componentType?: 'FormItem';
  templateWrap?: (
    templateSchema: any,
    {
      item,
    }: {
      item: any;
    },
  ) => any;
  showAssociationFields?: boolean;
  hideChildrenIfSingleCollection?: boolean;
  /**
   * 隐藏弹窗中的 Other records 选项
   */
  hideOtherRecordsInPopup?: boolean;
  /** 用于更改 Current record 的文案 */
  currentText?: string;
  /** 用于更改 Other records 的文案 */
  otherText?: string;
}) => {
  const itemConfig = useSchemaInitializerItem();
  const { createFormBlock, templateWrap } = useCreateFormBlock();
  const onCreateFormBlockSchema = useCallback(
    (options) => {
      if (createBlockSchema) {
        return createBlockSchema(options);
      }

      createFormBlock(options);
    },
    [createBlockSchema, createFormBlock],
  );

  return (
    <DataBlockInitializer
      {...itemConfig}
      icon={<FormOutlined />}
      componentType={componentType}
      templateWrap={(templateSchema, options) => {
        if (customizeTemplateWrap) {
          return customizeTemplateWrap(templateSchema, options);
        }

        return templateWrap(templateSchema, options);
      }}
      onCreateBlockSchema={onCreateFormBlockSchema}
      filter={filterCollections}
      onlyCurrentDataSource={onlyCurrentDataSource}
      hideSearch={hideSearch}
      showAssociationFields={showAssociationFields}
      hideChildrenIfSingleCollection={hideChildrenIfSingleCollection}
      hideOtherRecordsInPopup={hideOtherRecordsInPopup}
      currentText={currentText}
      otherText={otherText}
    />
  );
};

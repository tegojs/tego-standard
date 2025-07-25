import { useEffect, useState } from 'react';
import { Schema, useField, useFieldSchema } from '@tachybase/schema';

import { useTranslation } from 'react-i18next';

import { useTableFieldContext } from '../../..//block-provider';
import { CollectionFieldOptions_deprecated } from '../../../collection-manager';
import { useCollection } from '../../../data-source';
import { CollectionFieldOptions } from '../../../data-source/collection/Collection';
import { useFlag } from '../../../flag-provider';
import { useColumnSchema } from '../../../schema-component';
import { useSubFormValue } from '../../../schema-component/antd/association-field/hooks';
import { useBaseVariable } from './useBaseVariable';

/**
 * @deprecated
 * 该 hook 已废弃，请使用 `useCurrentObjectVariable` 代替
 *
 * 变量：`当前对象`
 * @param param0
 * @returns
 */
export const useIterationVariable = ({
  currentCollection,
  collectionField,
  schema,
  noDisabled,
  targetFieldSchema,
}: {
  currentCollection: string;
  collectionField: CollectionFieldOptions_deprecated;
  schema?: any;
  noDisabled?: boolean;
  /** 消费变量值的字段 */
  targetFieldSchema?: Schema;
}) => {
  // const { getActiveFieldsName } = useFormActiveFields() || {};
  const { t } = useTranslation();
  const result = useBaseVariable({
    collectionField,
    uiSchema: schema,
    targetFieldSchema,
    maxDepth: 4,
    name: '$iteration',
    title: t('Current object'),
    collectionName: currentCollection,
    noDisabled,
    returnFields: (fields, option) => {
      // fix
      return fields;
      // const activeFieldsName = getActiveFieldsName?.('nester') || [];

      // return option.depth === 0
      //   ? fields.filter((field) => {
      //       return activeFieldsName?.includes(field.name);
      //     })
      //   : fields;
    },
  });

  return result;
};

/**
 * 变量：`当前对象`
 * @param param0
 * @returns
 */
export const useCurrentObjectVariable = ({
  collectionField,
  schema,
  noDisabled,
  targetFieldSchema,
}: {
  collectionField?: CollectionFieldOptions;
  schema?: any;
  noDisabled?: boolean;
  /** 消费变量值的字段 */
  targetFieldSchema?: Schema;
} = {}) => {
  // const { getActiveFieldsName } = useFormActiveFields() || {};
  console.log('🚀 ~ targetFieldSchema:', targetFieldSchema);
  const collection = useCollection();
  const { formValue: currentObjectCtx, collection: collectionOfCurrentObject } = useSubFormValue();
  const { isInSubForm, isInSubTable } = useFlag() || {};
  const { t } = useTranslation();
  const currentObjectSettings = useBaseVariable({
    collectionField,
    uiSchema: schema,
    targetFieldSchema,
    maxDepth: 4,
    name: '$iteration',
    title: t('Current object'),
    collectionName: collectionOfCurrentObject?.name || collection?.name,
    noDisabled,
    returnFields: (fields, option) => {
      // fix
      return fields;
      // const activeFieldsName = getActiveFieldsName?.('nester') || [];

      // return option.depth === 0
      //   ? fields.filter((field) => {
      //       return activeFieldsName?.includes(field.name);
      //     })
      //   : fields;
    },
  });

  return {
    /** 是否显示变量 */
    shouldDisplayCurrentObject: isInSubForm || isInSubTable,
    /** 变量的值 */
    currentObjectCtx,
    /** 变量的配置项 */
    currentObjectSettings,
  };
};

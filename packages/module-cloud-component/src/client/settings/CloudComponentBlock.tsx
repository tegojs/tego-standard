import React from 'react';
import { useApp } from '@tachybase/client';
import { Schema } from '@tachybase/schema';

import { ErrorBoundary } from 'react-error-boundary';

import { useTranslation } from '../locale';

export const CloudComponentBlock = ({ element }) => {
  const { t } = useTranslation();
  const app = useApp();

  if (element && element !== 'CloudComponentVoid') {
    const Component = app.getComponent('CloudComponentVoid.' + element);

    return (
      <ErrorBoundary
        fallback={<div>{t('Something went wrong. Please contact the developer to resolve the issue.')}</div>}
      >
        <Component />
      </ErrorBoundary>
    );
  }
  return <div>{t('Please choose component to show here')}</div>;
};

export const addOptions = (props) => {
  const { option, targetFieldSchema, formInstance } = props;
  const extendField = (option, targetFieldSchema: Schema, formInstance) => {
    const children = [];
    if (option.depth === 0 && (formInstance || targetFieldSchema)) {
      const cloudItems = [];

      if (formInstance) {
        Object.values(formInstance['fields'])?.forEach((value) => {
          if (value['componentType'] === 'CloudComponentBlock') {
            cloudItems.push(value);
          }
        });
      } else if (targetFieldSchema && !formInstance) {
        getBlockSchema(targetFieldSchema, cloudItems);
      }
      if (cloudItems.length) {
        cloudItems.forEach((item) => {
          const key = item['componentProps']?.['element'] || item['x-component-props']?.['element'];
          const label =
            item['componentProps']?.['elementLabel'] ||
            item['componentProps']?.['element'] ||
            item['x-component-props']?.['element'] ||
            item['x-component-props']?.['elementLabel'];
          const value = item['componentProps']?.['element'] || item['x-component-props']?.['element'];
          children.push({
            depth: option.depth + 1,
            disabled: false,
            isLeaf: true,
            key,
            label,
            value,
          });
        });
      }
    }
    return children;
  };

  const getBlockSchema = (targetFieldSchema, cloudItems) => {
    if (!Object.values(targetFieldSchema?.properties || {}).length) return cloudItems;
    return Object.values(targetFieldSchema?.properties || {})?.forEach((schema) => {
      if (schema['x-component'] === 'CloudComponentBlock') {
        cloudItems.push(schema);
      }
      return getBlockSchema(schema, cloudItems);
    });
  };

  return extendField(option, targetFieldSchema, formInstance);
};

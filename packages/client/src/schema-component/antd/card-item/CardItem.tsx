import React, { useContext, useEffect, useState } from 'react';
import { useFieldSchema } from '@tachybase/schema';

import { Card } from 'antd';
import { useParams } from 'react-router';

import { useAPIClient } from '../../../api-client';
import { useTabContent } from '../../../built-in/page-style/TabContent';
import { useSchemaTemplate } from '../../../schema-templates';
import { SchemaComponent } from '../../core';
import { useDesignable } from '../../hooks';
import { BlockItem } from '../block-item';
import { CardItemProvider } from './CardItemProvider';
import useStyles from './style';

interface Props {
  children?: React.ReactNode;
  /** 卡片标识 */
  name?: string;
  [key: string]: unknown;
}

export const CardItem = (props: Props) => {
  const { children, name, ...restProps } = props;
  const template = useSchemaTemplate();
  const fieldSchema = useFieldSchema();
  const templateKey = fieldSchema?.['x-template-key'];
  const { styles } = useStyles();
  const { schemaUid, setSchemaUid } = useTabContent();
  const [component, setComponent] = useState({ schema: null, isRefresh: false });
  const api = useAPIClient();
  useEffect(() => {
    if (schemaUid.split('/')?.[0] === fieldSchema['x-uid']) {
      api
        .request({
          url: '/uiSchemas:getProperties/' + fieldSchema?.['x-uid'],
        })
        .then((res) => {
          setComponent({
            schema: res.data.data,
            isRefresh: true,
          });
        });
    }
  }, [schemaUid]);

  return templateKey && !template ? null : (
    <CardItemProvider value={{ cardItemUid: fieldSchema['x-uid'], setSchemaUid }}>
      <BlockItem name={name} className={`${styles} tb-card-item`}>
        <Card className="card" bordered={false} {...restProps}>
          {component.isRefresh ? <SchemaComponent schema={component.schema} /> : props.children}
        </Card>
      </BlockItem>
    </CardItemProvider>
  );
};

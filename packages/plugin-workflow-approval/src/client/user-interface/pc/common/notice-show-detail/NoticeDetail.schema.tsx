import { useContext } from 'react';
import {
  RemoteSchemaComponent,
  SchemaComponent,
  SchemaComponentProvider,
  useFormBlockContext,
} from '@tachybase/client';
import { DetailsBlockProvider } from '@tachybase/module-workflow/client';

import { tval } from '../../../../locale';
import { ApprovalContext } from '../ApprovalData.provider';
import { useContextMyComponent } from './contexts/MyComponent.context';
import { usePropsNoticeDetail } from './hooks/usePropsNoticeDetail';
import { NoticeDetailProvider } from './NoticeDetail.provider';

export const NoticeDetailContent = (props) => {
  const { record } = props;
  return (
    <NoticeDetailProvider>
      <NoticeDetail approval={record.approval} />
    </NoticeDetailProvider>
  );
};

const NoticeDetail = (props) => {
  const { approval } = props;
  const { id, schemaId } = useContextMyComponent();

  return (
    <SchemaComponent
      components={{
        NoticeDetailProvider,
        RemoteSchemaComponent,
        SchemaComponentProvider,
        DetailsBlockProvider,
      }}
      scope={{
        usePropsNoticeDetail,
        useDetailsBlockProps: useFormBlockContext,
      }}
      schema={{
        name: `content-${id}`,
        type: 'void',
        'x-component': 'Tabs',
        properties: {
          detail: {
            type: 'void',
            title: tval('Content Detail'),
            'x-component': 'Tabs.TabPane',
            properties: {
              approvalInfo: {
                type: 'void',
                'x-component': 'ApprovalCommon.ViewComponent.ApprovalInfo',
                'x-component-props': { approval },
              },
              detail: {
                type: 'void',
                'x-decorator': 'NoticeDetailProvider',
                'x-decorator-props': {
                  designable: false,
                },
                'x-component': 'RemoteSchemaComponent',
                'x-component-props': {
                  uid: schemaId,
                  noForm: true,
                },
              },
            },
          },
        },
      }}
    />
  );
};

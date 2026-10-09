import { useContext } from 'react';
import {
  RemoteSchemaComponent,
  SchemaComponent,
  SchemaComponentProvider,
  useFormBlockContext,
} from '@tachybase/client';
import { DetailsBlockProvider } from '@tachybase/module-workflow/client';

import { usePropsNoticeDetail } from '../../../../common/hook/usePropsNoticeDetail';
import { tval } from '../../../../locale';
import { useContextMyComponent } from './contexts/MyComponent.context';
import { NoticeDetailProvider } from './NoticeDetail.provider';
import { NoticeDetailData } from './NoticeDetailData';
import { NoticeFormBlockProvider } from './NoticeFormBlockProvider';

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
        NoticeDetailData,
        RemoteSchemaComponent,
        SchemaComponentProvider,
        DetailsBlockProvider,
        FormBlockProvider: NoticeFormBlockProvider,
      }}
      scope={{
        usePropsNoticeDetail,
        useDetailsBlockProps: useFormBlockContext,
        useFormBlockProps: usePropsNoticeDetail,
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
                'x-component': 'NoticeDetailData',
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

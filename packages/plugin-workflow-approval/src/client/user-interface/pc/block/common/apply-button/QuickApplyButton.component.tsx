import React, { useCallback, useContext, useEffect, useState } from 'react';
import {
  css,
  parseCollectionName,
  SchemaComponentContext,
  useActionContext,
  useAPIClient,
  useRecord,
  useRequest,
} from '@tachybase/client';
import { useForm } from '@tachybase/schema';

import { Result, Spin } from 'antd';

import {
  ApprovalDataProvider,
  ProviderContextApprovalExecution,
  QuickCreateContext,
  ResubmitContext,
} from '../../../../../common';
import { ProviderQuickApplyButton } from './QuickApplyButton.provider';
import { QuickViewApplyButton } from './QuickApplyButton.view';

export const QuickApplyButton = (props) => {
  const record = useRecord();
  const context = useContext(SchemaComponentContext);
  const apiClient = useAPIClient();
  const [visible, setVisible] = useState(false);
  const [items, setItems] = useState([]);
  const [schema, setSchema] = useState(null);
  const form = useForm();
  const ctx = useActionContext();
  const [ctxActionVisbile, setCtxActionVisbile] = useState(false);

  const { loading, data, run } = useRequest(
    {
      resource: 'approvalExecutions',
      action: 'get',
      params: {
        filter: { approvalId: record.approvalId || record.id },
        appends: [
          'execution',
          'execution.jobs',
          'approval',
          'approval.workflow',
          'approval.workflow.nodes',
          'approval.approvalExecutions',
          'approval.createdBy.id',
          'approval.records',
          'approval.records.node.title',
          'approval.records.node.config',
          'approval.records.job',
          'approval.records.user.nickname',
        ],
        except: ['approval.approvalExecutions.snapshot', 'approval.records.snapshot'],
      },
    },
    { manual: true },
  ) as any;
  const approvalData = data?.data;
  if (approvalData?.id && form.values?.voucherType) {
    delete approvalData?.['snapshot']?.['category'];
    delete approvalData?.['approval']?.['data']?.['category'];
    approvalData['approval']['workflow'] = items.find((item) => item?.id === form.values?.voucherType);
  }
  const { approval, execution, ...approvalValue } = approvalData || {};
  const { workflow } = approval || {};
  useEffect(() => {
    if (ctxActionVisbile && !visible) {
      ctx.setVisible(false);
      setCtxActionVisbile(false);
    }
  }, [visible]);

  useEffect(() => {
    run();
    apiClient
      .resource('workflows')
      .listApprovalFlows({ filter: { 'config.centralized': true, 'config.collection': record.collectionName } })
      .then(({ data }) => {
        setItems(data.data);
      })
      .catch(console.error);
  }, [record.id]);

  const onClick = useCallback(
    ({ key }) => {
      if (form.values.voucherType) {
        const targetItems = items.find((item) => item?.id === form.values?.voucherType);
        const { applyForm } = targetItems?.config ?? {};
        const [dataSource, name] = parseCollectionName(targetItems.config.collection);
        setSchema({
          type: 'void',
          properties: {
            [`drawer-${targetItems.id}`]: {
              type: 'void',
              title: targetItems.title,
              'x-decorator': 'ProviderContextWorkflow',
              'x-decorator-props': {
                value: {
                  workflow: targetItems,
                },
              },
              'x-component': 'Action.Drawer',
              'x-component-props': {
                className: css`
                  .ant-drawer-body {
                    background: var(--tb-box-bg);
                  }
                `,
              },
              properties: {
                [applyForm]: {
                  type: 'void',
                  'x-decorator': 'CollectionProvider_deprecated',
                  'x-decorator-props': {
                    name,
                    dataSource,
                  },
                  'x-component': 'RemoteSchemaComponent',
                  'x-component-props': {
                    uid: applyForm,
                    noForm: true,
                  },
                },
              },
            },
          },
        });
        setVisible(true);
        setCtxActionVisbile(true);
      }
    },
    [items],
  );

  // @ts-ignore

  if (loading) {
    return <Spin />;
  }

  if (!approvalData) {
    return <Result status="error" title="Loading failed" />;
  }

  return (
    <ApprovalDataProvider value={approval}>
      <ProviderContextApprovalExecution value={approvalData}>
        <QuickCreateContext.Provider value={{ isQuickCreate: true }}>
          <ResubmitContext.Provider value={{ isResubmit: true }}>
            <ProviderQuickApplyButton {...{ visible, setVisible, items, context, onClick }}>
              <QuickViewApplyButton schema={schema} approval={approval} workflow={workflow} />
            </ProviderQuickApplyButton>
          </ResubmitContext.Provider>
        </QuickCreateContext.Provider>
      </ProviderContextApprovalExecution>
    </ApprovalDataProvider>
  );
};

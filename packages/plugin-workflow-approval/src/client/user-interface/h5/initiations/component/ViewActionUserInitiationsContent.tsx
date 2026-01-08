import { useEffect, useState } from 'react';
import {
  MobileProvider,
  RemoteSchemaComponent,
  SchemaComponent,
  SchemaComponentProvider,
  useAPIClient,
  useDestroyAction,
  useFormBlockContext,
} from '@tachybase/client';
import { DetailsBlockProvider } from '@tachybase/module-workflow/client';
import { useForm } from '@tachybase/schema';

import { NavBar, Skeleton } from 'antd-mobile';
import { useNavigate, useParams } from 'react-router-dom';

import {
  ActionBarProvider,
  ApprovalDataProvider,
  ContextApprovalRecords,
  FormBlockProvider,
  ProviderActionReminder,
  ProviderActionResubmit,
  ProviderApplyActionStatus,
  ProviderContextApprovalExecution,
  ResubmitProvider,
  SchemaComponentContextProvider,
  useActionReminder,
  useActionResubmit,
  useFormBlockProps,
  useSubmitUpdate,
  useWithdrawAction,
  WithdrawActionProvider,
} from '../../../../common';
import { useTranslation } from '../../../../locale';

import '../../style/style.css';

export const ViewActionUserInitiationsContent = () => {
  const params = useParams();
  const navigate = useNavigate();
  const { id } = params;
  const [noDate, setNoDate] = useState(false);
  const [recordData, setRecordDate] = useState({});
  const { t } = useTranslation();
  const api = useAPIClient();
  useEffect(() => {
    api
      .request({
        url: 'approvalExecutions:get',
        params: {
          filterByTk: id,
          appends: [
            'execution',
            'execution.jobs',
            'approval',
            'approval.workflow',
            'approval.workflow.nodes',
            'approval.approvalExecutions',
            'approval.createdBy.id',
            'approval.createdBy.nickname',
            'approval.records',
            'approval.records.node.title',
            'approval.records.node.config',
            'approval.records.job',
            'approval.records.user.nickname',
          ],
          except: ['approval.approvalExecutions.snapshot', 'approval.records.snapshot'],
        },
      })
      .then((res) => {
        if (res.data?.data) {
          setRecordDate(res.data.data);
        } else {
          setNoDate(true);
        }
      })
      .catch(() => {
        console.error;
      });
  }, [id]);
  // @ts-ignore
  const { approval, execution, ...approvalValue } = recordData || {};
  const { workflow } = approval || {};

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#f3f3f3', overflow: 'auto' }}>
      <NavBar
        onBack={() => {
          navigate(-1);
        }}
        className="navBarStyle"
      >
        {t('Approval')}
      </NavBar>
      <ResubmitProvider>
        <div className="approvalContext">
          {Object.keys(recordData).length && !noDate ? (
            <ApprovalDataProvider value={approval}>
              <ContextApprovalRecords.Provider value={recordData}>
                <ProviderContextApprovalExecution value={recordData}>
                  {UserInitiationsComponent(workflow?.config.applyForm)}
                </ProviderContextApprovalExecution>
              </ContextApprovalRecords.Provider>
            </ApprovalDataProvider>
          ) : (
            <div>
              <Skeleton.Title animated />
              <Skeleton.Paragraph lineCount={5} animated />
            </div>
          )}
        </div>
      </ResubmitProvider>
    </div>
  );
};

const UserInitiationsComponent = (applyDetail) => {
  const formContextSchema = {
    type: 'void',
    'x-component': 'MobileProvider',
    properties: {
      page: {
        type: 'void',
        'x-component': 'MPage',
        'x-designer': 'MPage.Designer',
        'x-decorator': 'MobileProvider',
        'x-component-props': {},
        properties: {
          Approval: {
            type: 'void',
            'x-decorator': 'SchemaComponentContextProvider',
            'x-decorator-props': { designable: false },
            'x-component': 'RemoteSchemaComponent',
            'x-component-props': {
              uid: applyDetail,
              noForm: true,
            },
          },
          process: {
            type: 'void',
            'x-decorator': 'CardItem',
            'x-component': 'ApprovalCommon.ViewComponent.MApprovalProcess',
          },
        },
      },
    },
  };

  return (
    <SchemaComponent
      components={{
        SchemaComponentProvider: SchemaComponentProvider,
        RemoteSchemaComponent: RemoteSchemaComponent,
        SchemaComponentContextProvider,
        FormBlockProvider,
        ActionBarProvider,
        ApplyActionStatusProvider: ProviderApplyActionStatus,
        WithdrawActionProvider,
        DetailsBlockProvider,
        MobileProvider,
        ProviderActionResubmit,
        ProviderActionReminder,
      }}
      scope={{
        useForm,
        useSubmit: useSubmitUpdate,
        useFormBlockProps,
        useDetailsBlockProps: useFormBlockContext,
        useWithdrawAction,
        useDestroyAction,
        useActionResubmit,
        useActionReminder,
      }}
      schema={formContextSchema}
    />
  );
};

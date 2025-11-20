import React, { useContext } from 'react';
import {
  EnabledStatusFilter,
  ExtendCollectionsProvider,
  SchemaComponent,
  SchemaComponentContext,
  usePlugin,
} from '@tachybase/client';
import { onFieldChange, useField, useFormEffects } from '@tachybase/schema';

import WorkflowPlugin, { RadioWithTooltip } from '.';
import { AddWorkflowCategory, AddWorkflowCategoryAction } from './components/AddWorkflowCategory';
import { ColumnExecutedTime } from './components/ColumnExecutedTime';
import { ColumnShowCollection } from './components/ColumnShowCollection';
import { ColumnShowEventSource } from './components/ColumnShowEventSource';
import { ColumnShowTitle } from './components/ColumnShowTitle';
import { EditWorkflowCategory, EditWorkflowCategoryAction } from './components/EditWorkflowCategory';
import { ExecutionLink } from './components/ExecutionLink';
import { ExecutionRetryAction } from './components/ExecutionRetryAction';
import { ExecutionStatusColumn, ExecutionStatusSelect } from './components/ExecutionStatus';
import OpenDrawer from './components/OpenDrawer';
import { WorkflowCategoryColumn } from './components/WorkflowCategoryColumn';
import { useDumpAction, useRevisionAction } from './hooks';
import { ExecutionResourceProvider } from './provider/ExecutionResourceProvider';
import { executionCollection } from './schemas/executions';
import {
  collectionWorkflowCategories,
  collectionWorkflows,
  useCreateFormBlockProps,
  workflowSchema,
} from './schemas/workflows';
import { WorkflowLink } from './WorkflowLink';

function SyncOptionSelect(props) {
  const field = useField<any>();
  const workflowPlugin = usePlugin(WorkflowPlugin);

  useFormEffects(() => {
    onFieldChange('type', (f: any) => {
      let disabled = !f.value;
      if (f.value) {
        const trigger = workflowPlugin.triggers.get(f.value);
        if (trigger.sync != null) {
          disabled = true;
          field.setValue(trigger.sync);
        }
      }
      field.setPattern(disabled ? 'disabled' : 'editable');
    });
  });

  return <RadioWithTooltip {...props} />;
}

export function WorkflowPane(props) {
  const { schema = workflowSchema, components, scopes } = props;
  const ctx = useContext(SchemaComponentContext);

  const { getTriggersOptions } = usePlugin(WorkflowPlugin);
  return (
    <ExtendCollectionsProvider collections={[collectionWorkflows, executionCollection, collectionWorkflowCategories]}>
      <SchemaComponentContext.Provider value={{ ...ctx, designable: false }}>
        <SchemaComponent
          schema={schema}
          components={{
            WorkflowLink,
            ExecutionResourceProvider,
            ExecutionLink,
            OpenDrawer,
            ExecutionStatusSelect,
            SyncOptionSelect,
            ExecutionStatusColumn,
            ColumnShowTitle,
            ColumnShowCollection,
            AddWorkflowCategory,
            AddWorkflowCategoryAction,
            EditWorkflowCategory,
            EditWorkflowCategoryAction,
            ColumnShowEventSource,
            ColumnExecutedTime,
            WorkflowCategoryColumn,
            EnabledStatusFilter,
            ...components,
          }}
          scope={{
            getTriggersOptions,
            ExecutionRetryAction,
            useCreateFormBlockProps,
            useDumpAction,
            useRevisionAction,
            ...scopes,
          }}
        />
      </SchemaComponentContext.Provider>
    </ExtendCollectionsProvider>
  );
}

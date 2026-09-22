import React from 'react';
import { SchemaComponentOptions, usePlugin } from '@tachybase/client';

import PluginWorkflowClient, { FlowContext } from '..';
import { hasExecutionContext } from './execution-context';

export function ExecutionContextProvider({ children, workflow, execution, nodes }) {
  if (!hasExecutionContext(workflow, execution, nodes)) {
    return null;
  }

  const workflowPlugin = usePlugin(PluginWorkflowClient);
  const triggerComponents = workflowPlugin.triggers.get(workflow.type)?.components ?? {};

  const nodeComponents = nodes.reduce(
    (components, { type }) => Object.assign(components, workflowPlugin.instructions.get(type)?.components ?? {}),
    {},
  );

  return (
    <FlowContext.Provider
      value={{
        workflow,
        nodes,
        execution,
      }}
    >
      <SchemaComponentOptions
        components={{
          ...triggerComponents,
          ...nodeComponents,
        }}
      >
        {children}
      </SchemaComponentOptions>
    </FlowContext.Provider>
  );
}

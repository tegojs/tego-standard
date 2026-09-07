import React from 'react';
import { renderHook } from '@tachybase/test/client';

import { describe, expect, it, vi } from 'vitest';

import QueryInstruction from '../nodes/query';
import { useWorkflowVariableOptions } from '../variable';

const testState = vi.hoisted(() => ({
  currentNode: null as any,
  workflowPlugin: null as any,
}));

vi.mock('@tachybase/client', async () => {
  const actual = await vi.importActual<typeof import('@tachybase/client')>('@tachybase/client');
  return {
    ...actual,
    useCollectionManager_deprecated: () => {
      React.useState(null);
      return { getCollectionFields: () => [] };
    },
    useCompile: () => {
      React.useState(null);
      return (value) => value;
    },
    useGlobalVariable: () => ({ key: '$env', value: '$env', label: 'Environment variables', children: [] }),
    usePlugin: () => testState.workflowPlugin,
  };
});

vi.mock('../FlowContext', () => ({
  useFlowContext: () => ({ workflow: { type: 'collection', config: {} } }),
}));

vi.mock('../nodes/default-node/Node.context', () => ({
  useContextNode: () => testState.currentNode,
}));

describe('workflow variable options', () => {
  it('keeps hook order stable when an upstream query node is inserted', () => {
    const queryInstruction = new QueryInstruction();
    testState.workflowPlugin = {
      instructions: {
        get: () => queryInstruction,
      },
      triggers: {
        get: () => null,
      },
    };
    testState.currentNode = { id: 2, type: 'calculation', upstream: null };

    const { rerender } = renderHook(() => useWorkflowVariableOptions());

    testState.currentNode = {
      id: 2,
      type: 'calculation',
      upstream: {
        id: 1,
        type: 'query',
        key: 'query-node',
        title: 'Query records',
        config: {
          collection: 'users',
          params: { appends: [] },
        },
        upstream: null,
      },
    };

    expect(() => rerender()).not.toThrow();

    testState.currentNode = { id: 2, type: 'calculation', upstream: null };

    expect(() => rerender()).not.toThrow();
  });
});

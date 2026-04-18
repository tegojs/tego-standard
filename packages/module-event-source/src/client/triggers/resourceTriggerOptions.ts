import { tval } from '../locale';

export function createResourceTriggerOptions() {
  return {
    resourceName: {
      type: 'string',
      title: tval('Resource name'),
      'x-decorator': 'FormItem',
      'x-component': 'Input',
    },
    actionName: {
      type: 'string',
      title: tval('Action name'),
      'x-decorator': 'FormItem',
      'x-component': 'Input',
    },
    triggerOnAssociation: {
      type: 'boolean',
      title: tval('Trigger on association'),
      'x-decorator': 'FormItem',
      'x-component': 'Checkbox',
    },
    useHttpContext: {
      type: 'boolean',
      title: tval('Pass HTTP context to workflow'),
      'x-decorator': 'FormItem',
      'x-component': 'Checkbox',
    },
    failurePolicy: {
      type: 'string',
      title: tval('Failure policy'),
      'x-decorator': 'FormItem',
      'x-component': 'Select',
      enum: [
        { label: tval('Ignore failure'), value: 'ignore' },
        { label: tval('Block request on failure'), value: 'block' },
      ],
      default: 'ignore',
    },
    timeoutMs: {
      type: 'number',
      title: tval('Timeout (ms)'),
      'x-decorator': 'FormItem',
      'x-component': 'InputNumber',
      'x-component-props': {
        min: 0,
        step: 100,
      },
      default: 0,
    },
    executionMode: {
      type: 'string',
      title: tval('Execution mode'),
      'x-decorator': 'FormItem',
      'x-component': 'Select',
      enum: [
        { label: tval('Inline'), value: 'inline' },
        { label: tval('Queue'), value: 'queue' },
      ],
      default: 'inline',
    },
    maxAttempts: {
      type: 'number',
      title: tval('Max attempts'),
      'x-decorator': 'FormItem',
      'x-component': 'InputNumber',
      'x-component-props': {
        min: 1,
        step: 1,
      },
      default: 3,
    },
    retryBackoffMs: {
      type: 'number',
      title: tval('Retry backoff (ms)'),
      'x-decorator': 'FormItem',
      'x-component': 'InputNumber',
      'x-component-props': {
        min: 100,
        step: 100,
      },
      default: 3000,
    },
  };
}

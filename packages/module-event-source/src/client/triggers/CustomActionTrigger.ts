import { EventSourceTrigger } from '.';
import { NAMESPACE, tval } from '../locale';

export class CustomActionTrigger extends EventSourceTrigger {
  title = tval('Custom resource action');
  description = tval('for creating custom requests, try not to duplicate with other requests');
  options = {
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
      'x-component': 'NumberPicker',
      'x-component-props': {
        min: 0,
        step: 100,
      },
      default: 0,
    },
  };
}

import PluginErrorHandler from '@tachybase/module-error-handler';

import { describe, expect, it, vi } from 'vitest';

import { RequestInterceptionTrigger } from '../interception/RequestInterceptionTrigger';
import { OmniTrigger } from '../omni-trigger/CustomActionTrigger';

function createWorkflowWithClassOnlyErrorHandler() {
  const errorHandlerPlugin = {
    errorHandler: {
      register: vi.fn(),
    },
  };
  const app = {
    use: vi.fn(),
    resourcer: {
      registerActionHandler: vi.fn(),
      use: vi.fn(),
    },
    acl: {
      allow: vi.fn(),
    },
    pm: {
      get: vi.fn((nameOrClass) => {
        if (nameOrClass === 'error-handler') {
          return undefined;
        }
        if (nameOrClass === PluginErrorHandler) {
          return errorHandlerPlugin;
        }
        return undefined;
      }),
    },
  };

  return {
    workflow: { app } as any,
    errorHandlerPlugin,
  };
}

describe('workflow trigger error handler registration', () => {
  it('registers request interception errors when only class lookup is available', () => {
    const { workflow, errorHandlerPlugin } = createWorkflowWithClassOnlyErrorHandler();

    new RequestInterceptionTrigger(workflow);

    expect(workflow.app.pm.get).toHaveBeenCalledWith('error-handler');
    expect(workflow.app.pm.get).toHaveBeenCalledWith(PluginErrorHandler);
    expect(errorHandlerPlugin.errorHandler.register).toHaveBeenCalledTimes(1);
  });

  it('registers omni trigger errors when only class lookup is available', () => {
    const { workflow, errorHandlerPlugin } = createWorkflowWithClassOnlyErrorHandler();

    new OmniTrigger(workflow);

    expect(workflow.app.pm.get).toHaveBeenCalledWith('error-handler');
    expect(workflow.app.pm.get).toHaveBeenCalledWith(PluginErrorHandler);
    expect(errorHandlerPlugin.errorHandler.register).toHaveBeenCalledTimes(1);
  });
});

import path from 'node:path';
import { setupServerTestEnvironment } from '@tachybase/test/setup-server';
import { initEnv } from '@tego/devkit';

setupServerTestEnvironment({
  workspaceRoot: process.cwd(),
  pluginPaths: [path.resolve(process.cwd(), 'packages')],
  packageDirByPluginName: {
    acl: 'module-acl',
    auth: 'module-auth',
    'collection-manager': 'module-collection',
    'data-source-manager': 'module-data-source',
    'error-handler': 'module-error-handler',
    'ui-schema-storage': 'module-ui-schema',
    users: 'module-user',
    workflow: 'module-workflow',
    'workflow-test': 'plugin-workflow-test',
  },
  disableRuntimePlugins: true,
  disableOtherPlugins: true,
});

initEnv();

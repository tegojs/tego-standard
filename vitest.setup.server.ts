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
    'file-manager': 'module-file',
    'ui-schema-storage': 'module-ui-schema',
    users: 'module-user',
    tenant: 'module-tenant',
    workflow: 'module-workflow',
    'workflow-test': 'plugin-workflow-test',
    'audit-logs': 'plugin-audit-logs',
    'custom-request': 'plugin-action-custom-request',
    'localization-management': 'plugin-i18n-editor',
    'system-settings': 'module-app-info',
    oidc: 'plugin-auth-oidc',
    saml: 'plugin-auth-saml',
    'sms-auth': 'plugin-auth-sms',
    'api-keys': 'plugin-api-keys',
    map: 'plugin-block-map',
    'multi-app-manager': 'module-multi-app',
    'snapshot-field': 'plugin-field-snapshot',
    'sequence-field': 'plugin-field-sequence',
    'china-region': 'plugin-field-china-region',
    verification: 'plugin-otp',
    'evaluator-mathjs': 'plugin-evaluator-mathjs',
  },
  disableRuntimePlugins: true,
  disableOtherPlugins: true,
});

initEnv();

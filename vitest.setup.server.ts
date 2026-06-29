import { createRequire } from 'node:module';
import path from 'node:path';
import { setupServerTestEnvironment } from '@tachybase/test/setup-server';
import { initEnv } from '@tego/devkit';

// Workspace dist files are CommonJS and bypass Vitest aliases, so keep their
// core/server imports on the same runtime instance used by @tachybase/test.
const testRequire = createRequire(path.resolve(process.cwd(), 'node_modules/@tachybase/test/package.json'));
const runtimeResolutions = new Map([
  ['@tego/server', testRequire.resolve('@tego/server')],
  ['@tego/server/package.json', testRequire.resolve('@tego/server/package.json')],
  ['@tego/core', testRequire.resolve('@tego/core')],
  ['@tego/core/package.json', testRequire.resolve('@tego/core/package.json')],
]);

const resolverPatched = Symbol.for('tego-standard.cjs-resolver-patched');
if (!(globalThis as any)[resolverPatched]) {
  const { Module } = require('node:module') as typeof import('node:module');
  const mod = Module as typeof Module & { _resolveFilename: (request: string, ...args: unknown[]) => string };
  const original = mod._resolveFilename;
  mod._resolveFilename = function (request: string, ...args: unknown[]) {
    return runtimeResolutions.get(request) || original.call(this, request, ...args);
  };
  (globalThis as any)[resolverPatched] = true;
}

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

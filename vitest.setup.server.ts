import * as nodeModule from 'node:module';
import path from 'node:path';
import { setupServerTestEnvironment } from '@tachybase/test/setup-server';
import { initEnv } from '@tego/devkit';

// jsonwebtoken@8 pulls in buffer-equal-constant-time, which still references
// SlowBuffer.prototype during module initialization. Node 26 no longer exposes
// SlowBuffer, so provide the Buffer constructor for test compatibility.
const require = nodeModule.createRequire(import.meta.url);
const buffer = require('node:buffer');
buffer.SlowBuffer ??= buffer.Buffer;

// Workspace dist files are CommonJS and bypass Vitest aliases, so keep their
// core/server imports on the same runtime instance used by @tachybase/test.
const testRequire = nodeModule.createRequire(path.resolve(process.cwd(), 'node_modules/@tachybase/test/package.json'));
const runtimeResolutions = new Map([
  ['@tego/server', testRequire.resolve('@tego/server')],
  ['@tego/server/package.json', testRequire.resolve('@tego/server/package.json')],
  ['@tego/core', testRequire.resolve('@tego/core')],
  ['@tego/core/package.json', testRequire.resolve('@tego/core/package.json')],
]);
const resolverPatched = Symbol.for('tego-standard.server-test-runtime-resolver-patched');

type CommonJsModuleWithResolver = typeof nodeModule.Module & {
  _resolveFilename: (request: string, ...args: unknown[]) => string;
  [resolverPatched]?: true;
};

const commonJsModule = nodeModule.Module as CommonJsModuleWithResolver;

if (!commonJsModule[resolverPatched]) {
  const originalResolveFilename = commonJsModule._resolveFilename;

  commonJsModule._resolveFilename = function resolveTestRuntime(this: unknown, request: string, ...args: unknown[]) {
    return runtimeResolutions.get(request) || originalResolveFilename.call(this, request, ...args);
  };
  commonJsModule[resolverPatched] = true;
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

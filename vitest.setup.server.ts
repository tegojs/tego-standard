import fs from 'node:fs';
import path from 'node:path';
import { patchCjsResolverForTestRuntime, setupServerTestEnvironment } from '@tachybase/test/setup-server';
import { initEnv } from '@tego/devkit';
import { Plugin } from '@tego/server';

import { installVitestConsoleOutputFilter } from './vitest.console-filter';

installVitestConsoleOutputFilter();

// Patch CJS resolver to keep @tego/server and @tego/core on the same runtime
// instance used by @tachybase/test (prevents dual-instance bugs in workspace
// dist files that bypass Vitest aliases).
patchCjsResolverForTestRuntime();

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

/**
 * When the dist/ build tree is absent (fresh CI checkout), the upstream
 * `loadCollections` fallback resolves the package entry via `resolveRequest`
 * and only checks relative paths under dist/.  That silently skips collection
 * registration for every plugin that lacks `workspaceSource`.
 *
 * Extend the fallback: even without `workspaceSource`, derive the workspace
 * package directory from the packageName (`@tachybase/<dir> → packages/<dir>`)
 * and try src/server/collections before giving up.
 */
const __origLoadCollections = Plugin.prototype.loadCollections;
Plugin.prototype.loadCollections = async function patchedLoadCollections(this: any) {
  // Fast path: workspaceSource plugins are already handled by setupTestEnvironment
  if (this.options?.workspaceSource) {
    return __origLoadCollections.call(this);
  }

  const packageName: string | undefined = this.options?.packageName;
  const workspaceRoot = process.cwd();

  if (packageName?.startsWith('@tachybase/')) {
    const packageDir = packageName.replace('@tachybase/', '');
    const srcDir = path.resolve(workspaceRoot, 'packages', packageDir, 'src/server/collections');
    const distDir = path.resolve(workspaceRoot, 'packages', packageDir, 'dist/server/collections');
    const directory = fs.existsSync(distDir) ? distDir : fs.existsSync(srcDir) ? srcDir : null;
    if (directory) {
      return this.db.import({ directory, from: packageName });
    }
  }

  return __origLoadCollections.call(this);
};

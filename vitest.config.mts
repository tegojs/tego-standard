import { createRequire } from 'node:module';
import path from 'node:path';

import { defineTegoVitestConfig } from '@tachybase/test/vitest';

const actionImportRequire = createRequire(path.resolve(process.cwd(), 'packages/plugin-action-import/package.json'));
const clientSetupFile = path.resolve(process.cwd(), './vitest.setup.client.ts');
const config = defineTegoVitestConfig({
  server: {
    setupFile: path.resolve(process.cwd(), './vitest.setup.server.ts'),
  },
  client: {
    setupFile: clientSetupFile,
  },
});

const workspaceServerAliases = [
  ['@tachybase/module-acl', 'module-acl'],
  ['@tachybase/module-auth', 'module-auth'],
  ['@tachybase/module-collection', 'module-collection'],
  ['@tachybase/module-data-source', 'module-data-source'],
  ['@tachybase/module-error-handler', 'module-error-handler'],
  ['@tachybase/module-ui-schema', 'module-ui-schema'],
  ['@tachybase/module-user', 'module-user'],
  ['@tachybase/module-workflow', 'module-workflow'],
  ['@tachybase/plugin-workflow', 'module-workflow'],
  ['@tachybase/plugin-workflow-test', 'plugin-workflow-test'],
  ['@tachybase/plugin-auth-oidc', 'plugin-auth-oidc'],
  ['@tachybase/plugin-auth-saml', 'plugin-auth-saml'],
  ['@tachybase/plugin-api-keys', 'plugin-api-keys'],
  ['@tachybase/plugin-evaluator-mathjs', 'plugin-evaluator-mathjs'],
].map(([packageName, packageDir]) => ({
  find: packageName,
  replacement: path.resolve(process.cwd(), `packages/${packageDir}/src/server/index.ts`),
}));

const tegoServerRequire = createRequire(path.resolve(process.cwd(), 'packages/module-multi-app/package.json'));
const tegoServerPackageJson = tegoServerRequire.resolve('@tego/server/package.json');
const tegoServerEntry = tegoServerRequire.resolve('@tego/server');
const tegoCoreEntry = createRequire(tegoServerPackageJson).resolve('@tego/core');

const testRequire = createRequire(path.resolve(process.cwd(), 'node_modules/@tachybase/test/package.json'));

const projectAliases = [
  ...workspaceServerAliases,
  {
    find: '@tego/server',
    replacement: tegoServerEntry,
  },
  {
    find: '@tego/core',
    replacement: tegoCoreEntry,
  },
  {
    find: 'node-xlsx',
    replacement: actionImportRequire.resolve('node-xlsx'),
  },
  {
    find: 'packages/module-auth/src/constants',
    replacement: path.resolve(process.cwd(), 'packages/module-auth/src/constants.ts'),
  },
  {
    find: '@tachybase/test/setup-server',
    replacement: testRequire.resolve('@tachybase/test/setup-server'),
  },
];

config.test.alias = [...projectAliases, ...(config.test.alias || [])];
// Each client test worker loads @tachybase/client (full antd barrel export, ~500MB).
// Limit global concurrency to prevent system OOM on multi-core machines.
config.test.poolOptions = {
  ...(config.test.poolOptions || {}),
  threads: {
    ...((config.test.poolOptions as any)?.threads || {}),
    maxThreads: 4,
  },
};
for (const project of config.test.projects || []) {
  project.test.alias = [...projectAliases, ...(project.test.alias || [])];
  if (project.test.name === 'server') {
    // @tachybase/test ESM entry (es/index.mjs) uses createRequire which fails in vitest ESM context.
    // Force CJS entry for server tests.
    const testCjsEntry = testRequire.resolve('@tachybase/test');
    project.test.alias = [
      ...(project.test.alias || []),
      { find: '@tachybase/test', replacement: testCjsEntry },
    ];
  }
  if (project.test.name === 'client') {
    const setupFiles = project.test.setupFiles;
    project.test.setupFiles = Array.isArray(setupFiles) ? [...setupFiles, clientSetupFile] : [setupFiles, clientSetupFile].filter(Boolean);
  }
}

export default config;

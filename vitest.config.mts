import { createRequire } from 'node:module';
import path from 'node:path';

import { defineTegoVitestConfig } from '@tachybase/test/vitest';

const actionImportRequire = createRequire(path.resolve(process.cwd(), 'packages/plugin-action-import/package.json'));
const config = defineTegoVitestConfig({
  server: {
    setupFile: path.resolve(process.cwd(), './vitest.setup.server.ts'),
  },
});

const workspaceServerAliases = [
  ['@tachybase/module-acl', 'module-acl'],
  ['@tachybase/module-auth', 'module-auth'],
  ['@tachybase/module-collection', 'module-collection'],
  ['@tachybase/module-data-source', 'module-data-source'],
  ['@tachybase/module-error-handler', 'module-error-handler'],
  ['@tachybase/module-tenant', 'module-tenant'],
  ['@tachybase/module-ui-schema', 'module-ui-schema'],
  ['@tachybase/module-user', 'module-user'],
  ['@tachybase/module-workflow', 'module-workflow'],
  ['@tachybase/plugin-workflow-test', 'plugin-workflow-test'],
].map(([packageName, packageDir]) => ({
  find: packageName,
  replacement: path.resolve(process.cwd(), `packages/${packageDir}/src/server/index.ts`),
}));

const projectAliases = [
  ...workspaceServerAliases,
  {
    find: 'node-xlsx',
    replacement: actionImportRequire.resolve('node-xlsx'),
  },
  {
    find: 'packages/module-auth/src/constants',
    replacement: path.resolve(process.cwd(), 'packages/module-auth/src/constants.ts'),
  },
];

config.test.alias = [...projectAliases, ...(config.test.alias || [])];
for (const project of config.test.projects || []) {
  project.test.alias = [...projectAliases, ...(project.test.alias || [])];
}

export default config;

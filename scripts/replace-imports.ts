import path from 'node:path';

import { Project } from 'ts-morph';

const project = new Project({
  tsConfigFilePath: path.resolve(__dirname, '../tsconfig.json'),
});

const sourceFiles = project.getSourceFiles('**/*.{ts,tsx,js,jsx}');

// 这些包统一映射到 @tego/client
const specialClientPackages = new Set(['@tachybase/components', '@tachybase/requirejs', '@tachybase/sdk']);

// 这些包排除，不做任何替换
const excludePackages = new Set([
  '@tachybase/schema',
  '@tachybase/client',
  '@tachybase/globals',
  '@tachybase/loader',
  '@tachybase/sheet',
  '@tachybase/test',
  '@tachybase/test/client',
]);

const PRESERVE_PREFIXES = ['@tachybase/module-', '@tachybase/plugin-'];

const replacedImports: {
  originalModule: string;
  replacedModule: string;
  namedImports: string[];
  defaultImport?: string;
  filePath: string;
}[] = [];

for (const sourceFile of sourceFiles) {
  let changed = false;

  const imports = sourceFile.getImportDeclarations();

  for (const imp of imports) {
    const moduleSpec = imp.getModuleSpecifierValue();

    // 排除不替换的包
    if (excludePackages.has(moduleSpec) || PRESERVE_PREFIXES.some((p) => moduleSpec.startsWith(p))) {
      continue;
    }

    let replacedModule = '';

    if (specialClientPackages.has(moduleSpec)) {
      replacedModule = '@tego/client';
    } else {
      const clientMatch = moduleSpec.match(/^@tachybase\/([^/]+)\/client$/);
      if (clientMatch) {
        replacedModule = '@tego/client';
      } else {
        const serverMatch = moduleSpec.match(/^@tachybase\/([^/]+)$/);
        if (serverMatch) {
          replacedModule = '@tego/server';
        }
      }
    }

    if (replacedModule) {
      const namedImports = imp.getNamedImports().map((n) => n.getName());
      const defaultImport = imp.getDefaultImport()?.getText();

      replacedImports.push({
        originalModule: moduleSpec,
        replacedModule,
        namedImports,
        defaultImport,
        filePath: sourceFile.getFilePath(),
      });

      imp.setModuleSpecifier(replacedModule);
      changed = true;
    }
  }

  if (changed) {
    console.log(`Updated imports in: ${sourceFile.getFilePath()}`);
    sourceFile.saveSync();
  }
}

// const outputFile = path.resolve(__dirname, '../replaced-imports.json');
// fs.writeFileSync(outputFile, JSON.stringify(replacedImports, null, 2));

// console.log(`\nAll replaced import info saved to ${outputFile}`);
console.log('Done.');

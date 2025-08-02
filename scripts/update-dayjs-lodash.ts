import path from 'node:path';

import { Project } from 'ts-morph';

const project = new Project({
  tsConfigFilePath: 'tsconfig.json',
});

const TARGET_MODULES = ['@tego/client', '@tego/server'];

const lodashExports = new Set([
  'cloneDeep',
  'merge',
  'get',
  'set',
  'omit',
  'pick',
  'isEqual', // 可根据实际情况扩展
]);

const dayjsIdentifiers = new Set(['dayjs']);

project.getSourceFiles().forEach((sourceFile) => {
  let changed = false;

  sourceFile.getImportDeclarations().forEach((importDecl) => {
    const moduleSpecifier = importDecl.getModuleSpecifierValue();

    if (!TARGET_MODULES.includes(moduleSpecifier)) return;

    const namedImports = importDecl.getNamedImports();

    // lodash symbols
    const lodashSymbols = namedImports.filter((namedImport) => lodashExports.has(namedImport.getName()));

    // dayjs symbol (default import or named)
    const dayjsSymbols = namedImports.filter((namedImport) => dayjsIdentifiers.has(namedImport.getName()));

    // 移除匹配项
    if (lodashSymbols.length || dayjsSymbols.length) {
      // 如果该 import 全部都要移动，删除整个 import 声明
      if (namedImports.length === lodashSymbols.length + dayjsSymbols.length) {
        importDecl.remove();
      } else {
        // 只移除特定的符号
        [...dayjsSymbols].forEach((s) => s.remove());
      }

      // // 重建 lodash import
      // if (lodashSymbols.length) {
      //   const lodashNames = lodashSymbols.map((s) => s.getText()).join(', ');
      //   sourceFile.addImportDeclaration({
      //     namedImports: lodashNames,
      //     moduleSpecifier: 'lodash',
      //   });
      //   changed = true;
      // }

      // 重建 dayjs import（dayjs 通常是默认导出）
      if (dayjsSymbols.length) {
        sourceFile.addImportDeclaration({
          defaultImport: 'dayjs',
          moduleSpecifier: 'dayjs',
        });
        changed = true;
      }
    }
  });

  if (changed) {
    console.log(`Updated: ${sourceFile.getFilePath()}`);
  }
});

// 保存更改
project.save().then(() => {
  console.log('All files updated!');
});

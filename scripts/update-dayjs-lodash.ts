import { Project } from 'ts-morph';

const project = new Project({
  tsConfigFilePath: 'tsconfig.json',
});

const TARGET_MODULES = ['@tego/client', '@tego/server'];

const lodashExports = new Set(['lodash']);

const dayjsIdentifiers = new Set(['dayjs', 'Dayjs']);

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

    // 记录哪些是类型导入
    const typeOnlyDayjs = dayjsSymbols.filter((s) => s.isTypeOnly());
    const typeNames = typeOnlyDayjs.map((s) => ({ name: s.getName() }));
    const valueDayjs = dayjsSymbols.filter((s) => !s.isTypeOnly());

    // 移除匹配项
    if (lodashSymbols.length || dayjsSymbols.length) {
      // 如果该 import 全部都要移动，删除整个 import 声明
      if (namedImports.length === lodashSymbols.length + dayjsSymbols.length) {
        importDecl.remove();
      } else {
        // 只移除特定的符号
        [...lodashSymbols, ...dayjsSymbols].forEach((s) => s.remove());
      }

      if (lodashSymbols.length) {
        sourceFile.addImportDeclaration({
          defaultImport: 'lodash',
          moduleSpecifier: 'lodash',
        });
        changed = true;
      }

      // 重建 dayjs import（dayjs 通常是默认导出）
      if (valueDayjs.length) {
        sourceFile.addImportDeclaration({
          defaultImport: 'dayjs',
          moduleSpecifier: 'dayjs',
        });
        changed = true;
      }

      // dayjs 类型导入
      if (typeNames.length) {
        sourceFile.addImportDeclaration({
          isTypeOnly: true,
          namedImports: typeNames,
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

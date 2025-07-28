import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

import glob from 'fast-glob';
import { Project } from 'ts-morph';
import * as ts from 'typescript';

const PACKAGES_DIR = path.resolve(__dirname, '../packages');

// 判断一个路径是否是包目录
function isPackageDir(dirPath: string) {
  return fs.existsSync(path.join(dirPath, 'package.json'));
}

// 获取所有包目录
function getAllPackageDirs() {
  const subdirs = fs.readdirSync(PACKAGES_DIR);
  return subdirs.map((dir) => path.join(PACKAGES_DIR, dir)).filter((dir) => isPackageDir(dir));
}

// 提取导入的模块名
function extractModuleName(importPath: string) {
  if (importPath.startsWith('.') || importPath.startsWith('/')) return null;
  if (importPath.startsWith('@')) {
    const [scope, name] = importPath.split('/');
    return `${scope}/${name}`;
  }
  return importPath.split('/')[0];
}

// 分析单个包
async function analyzePackage(pkgDir: string) {
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
  const declaredDeps = Object.keys(pkgJson.dependencies || {});

  const srcDir = path.join(pkgDir, 'src');
  if (!fs.existsSync(srcDir)) return;

  const project = new Project({
    tsConfigFilePath: path.join(__dirname, '../tsconfig.server.json'),
    skipAddingFilesFromTsConfig: true,
  });

  const files = await glob(['**/*.ts', '**/*.tsx'], { cwd: srcDir, absolute: true });
  project.addSourceFilesAtPaths(files);

  const usedDeps = new Set<string>();

  project.getSourceFiles().forEach((sourceFile) => {
    sourceFile.getImportDeclarations().forEach((importDecl) => {
      const modName = extractModuleName(importDecl.getModuleSpecifierValue());
      if (
        modName &&
        !builtinModules.includes(modName) &&
        !modName.startsWith(pkgJson.name) // 自引用
      ) {
        usedDeps.add(modName);
      }
    });

    sourceFile.getExportDeclarations().forEach((exportDecl) => {
      const modSpecifier = exportDecl.getModuleSpecifierValue();
      if (modSpecifier) {
        const modName = extractModuleName(modSpecifier);
        if (modName && !builtinModules.includes(modName) && !modName.startsWith(pkgJson.name)) {
          usedDeps.add(modName);
        }
      }
    });

    sourceFile.getDescendantsOfKind(ts.SyntaxKind.CallExpression).forEach((callExpr) => {
      const expr = callExpr.getExpression().getText();
      if (expr === 'require') {
        const arg = callExpr.getArguments()[0];
        if (arg?.asKind(ts.SyntaxKind.StringLiteral)) {
          const modName = extractModuleName(arg.getText().slice(1, -1)); // remove quotes
          if (modName) usedDeps.add(modName);
        }
      }
    });
  });

  const unused = declaredDeps.filter((dep) => !usedDeps.has(dep));

  if (unused.length) {
    console.log(`\n[${pkgJson.name}] Unused dependencies:`);
    unused.forEach((dep) => console.log('  -', dep));
  }
}

// 主函数：遍历所有包
(async () => {
  const allPkgDirs = getAllPackageDirs();

  for (const dir of allPkgDirs) {
    await analyzePackage(dir);
  }

  console.log('\n✔️  Done checking all packages.');
})();

const fs = require('node:fs');
const path = require('node:path');

const PACKAGES_DIR = path.resolve(__dirname, '..', 'packages');

const PRESERVE_TACHYBASE = [
  '@tachybase/schema',
  '@tachybase/client',
  '@tachybase/globals',
  '@tachybase/loader',
  '@tachybase/sheet',
  '@tachybase/test',
  '@tachybase/test/client',
];

function shouldPreserve(name) {
  return PRESERVE_TACHYBASE.includes(name) || /^@tachybase\/(plugin|module)-/.test(name);
}

function processPackageJson(pkgPath) {
  const jsonPath = path.join(pkgPath, 'package.json');
  if (!fs.existsSync(jsonPath)) return;

  const pkg = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

  // 合并 peerDependencies 到 devDependencies
  const peerDeps = pkg.peerDependencies || {};
  const devDeps = pkg.devDependencies || {};

  for (const [dep, version] of Object.entries(peerDeps)) {
    if (!devDeps[dep]) {
      devDeps[dep] = version;
    }
  }

  delete pkg.peerDependencies;

  // 处理 devDependencies 中的 @tachybase/* 删除（除非在保留列表）
  for (const name of Object.keys(devDeps)) {
    if (name.startsWith('@tachybase/') && !shouldPreserve(name)) {
      delete devDeps[name];
    }
  }

  // 强制添加固定依赖
  devDeps['@tego/client'] = '*';
  devDeps['@tego/server'] = '*';

  pkg.devDependencies = devDeps;

  fs.writeFileSync(jsonPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`✅ Updated: ${path.relative(PACKAGES_DIR, pkgPath)}/package.json`);
}

function run() {
  const dirs = fs.readdirSync(PACKAGES_DIR);

  for (const dir of dirs) {
    if (!/^module-|^plugin-/.test(dir)) continue;

    const fullPath = path.join(PACKAGES_DIR, dir);
    if (fs.statSync(fullPath).isDirectory()) {
      processPackageJson(fullPath);
    }
  }
}

run();

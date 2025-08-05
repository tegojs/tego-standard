import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const PACKAGES_DIR = path.join(ROOT, 'packages');
const OUTPUT_PATH = path.join(ROOT, 'index.tego.json');

interface PluginEntry {
  name: string;
  source: 'npm';
  required: boolean;
}

interface IndexTegoJson {
  $schema: string;
  plugins: PluginEntry[];
  collections: {
    standard: (string | PluginEntry)[];
  };
}

function scanPlugins(): PluginEntry[] {
  const pluginDirs = fs
    .readdirSync(PACKAGES_DIR)
    .filter((name) => name.startsWith('plugin-') || name.startsWith('module-'));

  const plugins: PluginEntry[] = [];

  for (const dir of pluginDirs) {
    const fullPath = path.join(PACKAGES_DIR, dir);
    const pkgJsonPath = path.join(fullPath, 'package.json');

    if (!fs.existsSync(pkgJsonPath)) continue;

    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    const isModule = dir.startsWith('module-');

    plugins.push({
      name: pkg.name,
      source: 'npm',
      required: isModule,
    });
  }

  return plugins;
}

function generateIndex(): IndexTegoJson {
  const plugins = scanPlugins();

  return {
    $schema: './index.tego.schema.json',
    plugins,
    collections: {
      standard: plugins.map((p) => p.name),
    },
  };
}

// main
const indexJson = generateIndex();
fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
fs.writeFileSync(OUTPUT_PATH, JSON.stringify(indexJson, null, 2), 'utf8');

console.log(`✅ index.tego.json generated at ${OUTPUT_PATH}`);

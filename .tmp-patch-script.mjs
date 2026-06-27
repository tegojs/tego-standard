import { readFileSync, writeFileSync } from 'fs';
const dir = process.argv[2];

// === database.js: wrap sequelize.sync() in try/finally with SQLite FK ===
let code = readFileSync(`${dir}/lib/database.js`, 'utf8');

// Insert isSQLite + PRAGMA OFF before sync call
code = code.replace(
  '    const result = await this.sequelize.sync(options);',
  [
    '    const isSQLite = this.inDialect("sqlite");',
    '    if (isSQLite) {',
    '      await this.sequelize.query("PRAGMA foreign_keys = OFF");',
    '    }',
    '',
    '    try {',
    '    const result = await this.sequelize.sync(options);',
  ].join('\n')
);

// Wrap existing MySQL re-enable in finally block and add SQLite re-enable
code = code.replace(
  /    if \(isMySQL\) \{\n      await this\.sequelize\.query\("SET FOREIGN_KEY_CHECKS = 1", null\);\n    \}\n    return result;/,
  [
    '    } finally {',
    '      if (isMySQL) {',
    '        await this.sequelize.query("SET FOREIGN_KEY_CHECKS = 1", null);',
    '      }',
    '      if (isSQLite) {',
    '        await this.sequelize.query("PRAGMA foreign_keys = ON");',
    '      }',
    '    }',
  ].join('\n')
);

writeFileSync(`${dir}/lib/database.js`, code);

// === sort-field.js ===
let sf = readFileSync(`${dir}/lib/fields/sort-field.js`, 'utf8');

// C: escape scope values
sf = sf.replace(
  /`\$\{v\}'/g,
  'escape(v)'
);

// Add escape binding after queryInterface
sf = sf.replace(
  'const queryInterface = this.collection.db.sequelize.getQueryInterface();',
  'const queryInterface = this.collection.db.sequelize.getQueryInterface();\n        const escape = this.collection.db.sequelize.escape.bind(this.collection.db.sequelize);'
);

// E: fix falsy scope checks
sf = sf.replace(
  /if \(scopeKey && scopeValue\)/g,
  'if (scopeKey != null && scopeValue != null)'
);

// D: narrow catch block
sf = sf.replace(
  /} catch \{\n[\s\S]*?Sort values will be initialized on first actual write\.\n\s+\}/,
  `} catch (err) {\n      const msg = err instanceof Error ? err.message : String(err);\n      const isMissingTable = /no such table|relation .* does not exist|Table .* doesn't exist|No description found|SQLITE_ERROR/i.test(msg);\n      if (!isMissingTable) {\n        throw err;\n      }\n    }`
);

writeFileSync(`${dir}/lib/fields/sort-field.js`, sf);

console.log('Patched successfully');
console.log('isSQLite:', (readFileSync(`${dir}/lib/database.js`, 'utf8').match(/isSQLite/g) || []).length);
console.log('escape:', (readFileSync(`${dir}/lib/fields/sort-field.js`, 'utf8').match(/escape\(v\)/g) || []).length);
console.log('isMissingTable:', (readFileSync(`${dir}/lib/fields/sort-field.js`, 'utf8').match(/isMissingTable/g) || []).length);

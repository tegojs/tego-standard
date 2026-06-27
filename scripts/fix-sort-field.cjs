const fs = require('fs');
const path = require('path');

const dbDir = path.resolve(process.argv[2]);
const sfPath = path.join(dbDir, 'lib/fields/sort-field.js');

let sf = fs.readFileSync(sfPath, 'utf8');

// C: escape scope values
sf = sf.replace(
  "filteredScopeValue.map((v) => `'${v}'`).join(\", \")",
  'filteredScopeValue.map((v) => escape(v)).join(", ")'
);

// Add escape binding after queryInterface
sf = sf.replace(
  'const queryInterface = this.collection.db.sequelize.getQueryInterface();',
  'const queryInterface = this.collection.db.sequelize.getQueryInterface();\n        const escape = this.collection.db.sequelize.escape.bind(this.collection.db.sequelize);'
);

// E: fix falsy scope checks
sf = sf.replace('if (scopeKey2 && scopeValue) {', 'if (scopeKey2 != null && scopeValue != null) {');
sf = sf.replace('const whereClause = scopeKey2 && scopeValue', 'const whereClause = scopeKey2 != null && scopeValue != null');

// D: wrap in try-catch for missing-table errors
sf = sf.replace(
  'this.initRecordsSortValue = /* @__PURE__ */ __name(async ({ transaction }) => {',
  'this.initRecordsSortValue = /* @__PURE__ */ __name(async ({ transaction }) => {\n    try {'
);
sf = sf.replace(
  '}, "initRecordsSortValue");',
  '    } catch (err) { const msg = err instanceof Error ? err.message : String(err); if (!/no such table|does not exist|SQLITE_ERROR/i.test(msg)) { throw err; } }\n  }, "initRecordsSortValue");'
);

fs.writeFileSync(sfPath, sf);
console.log('Done. escape:', (sf.match(/escape\(v\)/g)||[]).length, 'null check:', (sf.match(/!= null/g)||[]).length, 'catch:', (sf.match(/no such table/g)||[]).length);

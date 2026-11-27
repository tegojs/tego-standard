import { Database, mockDatabase, type Transaction } from '@tego/server';

import { compileAccessScopes } from '../../access-control/compile';
import type { AccessConfig, CollectionMetadata, Scalar } from '../../access-control/types';
import { documents, exampleConfig, quoteIdentifier } from './fixtures';

export function sqliteDatabase() {
  return mockDatabase({ dialect: 'sqlite', storage: ':memory:', logging: false });
}

export function isolatedPostgresDatabase(url: string) {
  const connection = new URL(url);
  const database = connection.pathname.slice(1);
  if (
    !['postgres:', 'postgresql:'].includes(connection.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(connection.hostname) ||
    !/^tego_tenant_access_test_[a-f0-9]{10}$/.test(database)
  ) {
    throw new Error('Tenant access prototypes require a dedicated local test database');
  }
  return new Database({
    dialect: 'postgres',
    host: connection.hostname,
    port: Number(connection.port || 5432),
    database,
    username: decodeURIComponent(connection.username),
    password: decodeURIComponent(connection.password),
    logging: false,
    pool: { max: 5 },
  });
}

export async function queryRows<T>(
  db: Database,
  sql: string,
  options: {
    bind?: Record<string, Scalar>;
    logging?: (sql: string) => void;
    transaction?: Transaction;
  } = {},
): Promise<T[]> {
  const [rows] = await db.sequelize.query(sql, options);
  return rows as T[];
}

export async function seedDatabase(db: Database) {
  await db.sequelize.query(
    'CREATE TABLE access_documents (id INTEGER PRIMARY KEY, tenant_id VARCHAR(50), amount INTEGER NOT NULL, name VARCHAR(255))',
  );
  await db.sequelize.query(
    'CREATE TABLE access_participants (id INTEGER PRIMARY KEY, document_id INTEGER, business_tenant VARCHAR(50), can_view BOOLEAN)',
  );
  await db.sequelize.query(
    'CREATE INDEX access_participant_lookup ON access_participants (document_id, business_tenant, can_view)',
  );
  await db.sequelize.query('CREATE TABLE access_links (document_id INTEGER, participant_id INTEGER)');
  await db.sequelize.query('CREATE TABLE access_tenants (id VARCHAR(50) PRIMARY KEY, parent_id VARCHAR(50))');
  await db.sequelize.query("INSERT INTO access_tenants VALUES ('H', NULL), ('B', 'H'), ('C', 'H')");
  await db.sequelize.query(
    "INSERT INTO access_documents VALUES (1, 'H', 100, 'D1'), (2, 'H', 200, 'D2'), (3, 'B', 300, 'D3'), (4, 'C', 400, 'D4'), (5, NULL, 500, 'D5'), (6, 'H', 600, 'D6')",
  );
  await db.sequelize.query(
    "INSERT INTO access_participants VALUES (1, 1, 'B', TRUE), (2, 1, 'B', TRUE), (3, 6, 'B', FALSE), (4, 6, 'C', TRUE)",
  );
  await db.sequelize.query('INSERT INTO access_links VALUES (1, 1), (1, 2), (6, 3), (6, 4)');
}

export async function selectDocuments(
  db: Database,
  tenant: string,
  scope: 'read' | 'ownership' | 'visibility' = 'read',
  config: AccessConfig = exampleConfig,
  collection: CollectionMetadata = documents,
  rootAlias = 'tac_root',
) {
  const plan = compileAccessScopes(config, {
    collection,
    context: { 'tenant.id': tenant },
    quoteIdentifier,
    rootAlias,
  });
  return queryRows<{ id: number }>(
    db,
    `SELECT "${rootAlias}".id FROM access_documents AS "${rootAlias}" WHERE ${plan[scope].sql} ORDER BY id`,
    { bind: plan[scope].bind },
  );
}

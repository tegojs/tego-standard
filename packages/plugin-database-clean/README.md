# @tachybase/plugin-database-clean

Database Clean Plugin - View table usage and clean database tables

## Features

- 📊 View whitelisted table usage: size, row count, creation time, update time
- 🔍 Data filtering: Filter by createdAt and updatedAt time ranges
- 💾 Data backup: Reuse module-backup backup logic, support filtered data backup
- 🗑️ Data cleanup: Safe physical deletion with filtered data cleanup
- 🔒 Security control: Whitelist mechanism, only allows operations on specified tables

## Installation

```bash
pnpm pm add @tachybase/plugin-database-clean
pnpm pm enable @tachybase/plugin-database-clean
```

## Usage

### Configure Whitelist

Configure whitelist tables in `src/server/constants.ts`:

```typescript
export const WHITELIST_TABLES = [
  'users',
  'orders',
  'logs',
];
```

### Permission Configuration

The plugin automatically registers ACL snippet: `pm.database-clean.*`

Configure corresponding permissions in role permissions to use.

## API

### Get Table List

```
GET /databaseClean:list
```

### Get Table Data

```
GET /databaseClean:data?filterByTk=users&page=1&pageSize=20
```

### Backup Data

```
POST /databaseClean:backup
{
  "collectionName": "users",
  "filter": {
    "createdAt": {
      "$gte": "2024-01-01T00:00:00Z",
      "$lte": "2024-12-31T23:59:59Z"
    }
  }
}
```

### Clean Data

```
POST /databaseClean:clean
{
  "collectionName": "users",
  "filter": {
    "createdAt": {
      "$gte": "2024-01-01T00:00:00Z",
      "$lte": "2024-12-31T23:59:59Z"
    }
  }
}
```

## Notes

- Currently only supports PostgreSQL database
- Only allows operations on whitelisted tables
- Backup must be completed before cleanup operations
- Cleanup operations are physical deletions, please use with caution

## Documentation

For detailed requirements and implementation documentation, please refer to [REQUIREMENTS.md](./REQUIREMENTS.md)
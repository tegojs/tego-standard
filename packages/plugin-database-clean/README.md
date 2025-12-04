# @tachybase/plugin-database-clean

Database Clean Plugin - View table usage and clean database tables

## Features

- 📊 **Table Overview**: View whitelisted table usage including size, row count, creation time, update time
- 🔍 **Data Filtering**: Filter by createdAt/updatedAt time ranges or ID range
- 💾 **Data Backup**: Backup filtered data before cleaning (`.tbdump` format, compatible with module-backup)
- 🗑️ **Data Cleanup**: Safe physical deletion with filtered data cleanup
- 📦 **Batch Cleaning**: Support batch cleaning for large datasets (split by count or batch size, up to 1000 batches)
- 🔄 **Space Release**: Optional VACUUM FULL to release disk space after cleaning
- 🔒 **Security Control**: Whitelist mechanism, only allows operations on specified tables
- 🏗️ **Database Adapter**: Extensible adapter architecture for future database support (currently PostgreSQL only)

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

## UI Workflow

1. **Table List Page**: View all whitelisted tables with their size, row count, and time info
2. **Table Detail Page**: 
   - View table data with pagination
   - Filter by time range (createdAt/updatedAt) or ID range
   - Click "Clean" button to start the cleaning workflow
3. **Cleaning Workflow**:
   - Step 1: Choose to backup first or clean directly
   - Step 2: If backup, optionally download the backup file
   - Step 3: Configure batch settings (no batch / split into N batches / N records per batch)
   - Step 4: Choose to release disk space (VACUUM FULL) or clean only
   - During cleaning: Button shows progress like "(1/100) Cleaning..."

## API

### Get Table List

```
GET /databaseClean:list
```

### Get Table Info

```
GET /databaseClean:get?filterByTk=tableName
```

Returns: Table info including `hasCreatedAt`, `hasUpdatedAt`, `minId`, `maxId`

### Get Table Data

```
GET /databaseClean:data?filterByTk=tableName&page=1&pageSize=20&filter=...
```

Returns: Paginated data with `filteredMinId`, `filteredMaxId` for batch cleaning support

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
  },
  "vacuum": true  // Optional: Execute VACUUM FULL after cleaning
}
```

### Download Backup File

```
GET /databaseClean:download?filterByTk=db-clean_users_20240101_120000.tbdump
```

## Backup File Format

Backup files use `.tbdump` format (compatible with `module-backup`):
- Filename: `db-clean_{tableName}_{filterRange}_{timestamp}_{random}.tbdump`
- Contains: JSON-formatted data with meta information
- Can be restored using standard backup restore procedures

## Notes

- Currently only supports PostgreSQL database
- Only allows operations on whitelisted tables
- Backup is optional before cleanup (recommended but not required)
- Cleanup operations are physical deletions, please use with caution
- **VACUUM FULL**: Locks the table during execution, may take a long time for large tables
- **Batch Cleaning**: For large datasets, it's recommended to use batch cleaning to avoid long-running transactions

## Documentation

For detailed requirements and implementation documentation, please refer to [REQUIREMENTS.md](./REQUIREMENTS.md)
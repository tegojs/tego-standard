export const EXPORT_LENGTH_MAX = +process.env.EXPORT_LENGTH_MAX || 2000;
export const EXPORT_WORKER_PAGESIZE = +process.env.EXPORT_WORKER_PAGESIZE || 1000;

function parseBulkExportThreshold(value: string | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1_000_000 ? parsed : 1000;
}

export const BULK_EXPORT_THRESHOLD = parseBulkExportThreshold(process.env.BULK_EXPORT_THRESHOLD);

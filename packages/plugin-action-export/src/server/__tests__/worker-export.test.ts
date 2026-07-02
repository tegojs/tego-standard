import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import ExportPlugin from '../index';

describe('workerExportXlsx', () => {
  it('should apply full tenant context to worker repository queries', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'tego-export-worker-'));
    const find = vi.fn().mockResolvedValue([]);
    const repository = {
      collection: {
        options: {
          tenancy: 'tenantInherited',
          legacyDataTenantIds: ['tenant-a'],
        },
        fields: new Map([
          [
            'title',
            {
              name: 'title',
              options: {
                interface: 'input',
              },
            },
          ],
        ]),
        hasField: vi.fn().mockReturnValue(true),
      },
      find,
    };
    const plugin = {
      db: {
        getRepository: vi.fn().mockReturnValue(repository),
      },
      xlsxStorageDir: () => tempDir,
    };

    try {
      await ExportPlugin.prototype.workerExportXlsx.call(plugin, {
        title: 'tenant-export-posts',
        filter: {
          status: 'published',
        },
        columns: [
          {
            dataIndex: ['title'],
            defaultTitle: 'Title',
            title: 'Title',
          },
        ],
        resourceName: 'tenant_export_worker_posts',
        currentTenantId: 'tenant-a',
        tenantContext: {
          currentTenant: {
            id: 'tenant-a',
          },
          currentTenantId: 'tenant-a',
          currentTenancyMode: 'tenantInherited',
          currentTenantDescendantIds: ['tenant-a-child'],
          currentLegacyDataTenantIds: ['tenant-a'],
        },
      });

      expect(find).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: {
            $and: [
              { status: 'published' },
              {
                $or: [
                  {
                    tenantId: {
                      $in: ['tenant-a', 'tenant-a-child'],
                    },
                  },
                  { tenantId: null },
                ],
              },
            ],
          },
          context: {
            state: expect.objectContaining({
              currentTenantId: 'tenant-a',
              currentTenantDescendantIds: ['tenant-a-child'],
              currentTenancyMode: 'tenantInherited',
              currentLegacyDataTenantIds: ['tenant-a'],
            }),
          },
        }),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should intersect caller tenant constraints with inherited tenant scope', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'tego-export-worker-'));
    const find = vi.fn().mockResolvedValue([]);
    const repository = {
      collection: {
        options: {
          tenancy: 'tenantInherited',
        },
        fields: new Map([
          [
            'title',
            {
              name: 'title',
              options: {
                interface: 'input',
              },
            },
          ],
        ]),
        hasField: vi.fn().mockReturnValue(true),
      },
      find,
    };
    const plugin = {
      db: {
        getRepository: vi.fn().mockReturnValue(repository),
      },
      xlsxStorageDir: () => tempDir,
    };

    try {
      await ExportPlugin.prototype.workerExportXlsx.call(plugin, {
        title: 'tenant-export-posts',
        filter: {
          status: 'published',
          tenantId: 'tenant-a-child',
        },
        columns: ['title'],
        resourceName: 'tenant_export_worker_posts',
        currentTenantId: 'tenant-a',
        tenantContext: {
          currentTenant: {
            id: 'tenant-a',
          },
          currentTenantId: 'tenant-a',
          currentTenancyMode: 'tenantInherited',
          currentTenantDescendantIds: ['tenant-a-child', 'tenant-a-other-child'],
        },
      });

      expect(find).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: {
            $and: [
              { status: 'published', tenantId: 'tenant-a-child' },
              { tenantId: { $in: ['tenant-a', 'tenant-a-child', 'tenant-a-other-child'] } },
            ],
          },
        }),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should preserve falsy primitive values inside caller filter arrays', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'tego-export-worker-'));
    const find = vi.fn().mockResolvedValue([]);
    const repository = {
      collection: {
        options: {
          tenancy: 'tenantScoped',
        },
        fields: new Map([
          [
            'title',
            {
              name: 'title',
              options: {
                interface: 'input',
              },
            },
          ],
        ]),
        hasField: vi.fn().mockReturnValue(true),
      },
      find,
    };
    const plugin = {
      db: {
        getRepository: vi.fn().mockReturnValue(repository),
      },
      xlsxStorageDir: () => tempDir,
    };

    try {
      await ExportPlugin.prototype.workerExportXlsx.call(plugin, {
        title: 'tenant-export-posts',
        filter: {
          status: {
            $in: [0, false, ''],
          },
        },
        columns: ['title'],
        resourceName: 'tenant_export_worker_posts',
        currentTenantId: 'tenant-a',
        tenantContext: {
          currentTenantId: 'tenant-a',
          currentTenancyMode: 'tenantScoped',
        },
      });

      expect(find).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: {
            $and: [{ status: { $in: [0, false, ''] } }, { tenantId: 'tenant-a' }],
          },
        }),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should normalize string-array columns and keep tenant-aware worker path', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'tego-export-worker-'));
    const repository = {
      collection: {
        options: {
          tenancy: 'tenantScoped',
        },
        fields: new Map([
          [
            'title',
            {
              name: 'title',
              options: {
                interface: 'input',
              },
            },
          ],
        ]),
        hasField: vi.fn().mockReturnValue(true),
      },
      find: vi.fn().mockResolvedValue([]),
    };
    const plugin = {
      db: {
        getRepository: vi.fn().mockReturnValue(repository),
      },
      xlsxStorageDir: () => tempDir,
    };

    try {
      const result = await ExportPlugin.prototype.workerExportXlsx.call(plugin, {
        title: 'tenant-export-posts',
        filter: {},
        columns: ['title'],
        resourceName: 'tenant_export_worker_posts',
        currentTenantId: 'tenant-a',
        tenantContext: {
          currentTenantId: 'tenant-a',
          currentTenancyMode: 'tenantScoped',
        },
      });

      expect(result).toContain('storage/uploads/tenants/tenant-a/');
      expect(result).toContain('tenant-a');
      expect(repository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          context: {
            state: expect.objectContaining({
              currentTenantId: 'tenant-a',
            }),
          },
        }),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should fail closed when worker tenant context is missing for tenant-scoped collections', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'tego-export-worker-'));
    const repository = {
      collection: {
        options: {
          tenancy: 'tenantScoped',
        },
        fields: new Map([
          [
            'title',
            {
              name: 'title',
              options: {
                interface: 'input',
              },
            },
          ],
        ]),
        hasField: vi.fn().mockReturnValue(true),
      },
      find: vi.fn().mockResolvedValue([]),
    };
    const plugin = {
      db: {
        getRepository: vi.fn().mockReturnValue(repository),
      },
      xlsxStorageDir: () => tempDir,
    };

    try {
      await expect(
        ExportPlugin.prototype.workerExportXlsx.call(plugin, {
          title: 'tenant-export-posts',
          filter: {},
          columns: ['title'],
          resourceName: 'tenant_export_worker_posts',
        }),
      ).rejects.toThrow(/Tenant context is required/);
      expect(repository.find).not.toHaveBeenCalled();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should not apply tenant scope to shared collections from tenant context alone', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'tego-export-worker-'));
    const repository = {
      collection: {
        options: {},
        fields: new Map([
          [
            'title',
            {
              name: 'title',
              options: {
                interface: 'input',
              },
            },
          ],
        ]),
        hasField: vi.fn().mockReturnValue(true),
      },
      find: vi.fn().mockResolvedValue([]),
    };
    const plugin = {
      db: {
        getRepository: vi.fn().mockReturnValue(repository),
      },
      xlsxStorageDir: () => tempDir,
    };

    try {
      await ExportPlugin.prototype.workerExportXlsx.call(plugin, {
        title: 'shared-export-posts',
        filter: { status: 'published' },
        columns: ['title'],
        resourceName: 'shared_export_worker_posts',
        currentTenantId: 'tenant-a',
        tenantContext: {
          currentTenantId: 'tenant-a',
          currentTenancyMode: 'tenantScoped',
        },
      });

      expect(repository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: { status: 'published' },
        }),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

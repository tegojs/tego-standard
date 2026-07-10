import { buildAttachmentUploadHeaders } from '../../instructions/attachment-upload-headers';

describe('workflow attachment upload headers', () => {
  it('should include execution tenant id for internal attachment uploads', () => {
    const headers = buildAttachmentUploadHeaders(
      {
        'content-type': 'multipart/form-data; boundary=test',
      },
      'workflow-token',
      {
        state: {
          currentTenantId: 'tenant-b',
        },
      },
    );

    expect(headers).toMatchObject({
      'content-type': 'multipart/form-data; boundary=test',
      Authorization: 'Bearer workflow-token',
      'X-Tenant-Id': 'tenant-b',
    });
  });

  it('should prefer current tenant object id when present', () => {
    const headers = buildAttachmentUploadHeaders({}, 'workflow-token', {
      state: {
        currentTenant: {
          id: 'tenant-from-object',
        },
        currentTenantId: 'tenant-from-id',
      },
    });

    expect(headers['X-Tenant-Id']).toBe('tenant-from-object');
  });

  it('should omit tenant header when execution has no tenant context', () => {
    const headers = buildAttachmentUploadHeaders({}, 'workflow-token', {
      state: {},
    });

    expect(headers).toEqual({
      Authorization: 'Bearer workflow-token',
    });
  });

  it('should preserve numeric zero tenant id', () => {
    const headers = buildAttachmentUploadHeaders({}, 'workflow-token', {
      state: {
        currentTenantId: 0,
      },
    });

    expect(headers['X-Tenant-Id']).toBe(0);
  });
});

import React from 'react';
import { APIClientProvider } from '@tachybase/client';
import { act, fireEvent, render, waitFor } from '@tachybase/test/client';

import { TenantMigrationPreview } from '../TenantMigrationPreview';

const collection = { name: 'documents', title: 'Documents' };
const tenants = [{ id: 'B', name: 'Branch B' }];
const report = (tenancy = 'tenantScoped', options: object = {}) => ({
  identity: { dataSourceKey: 'main', collectionName: 'documents', collectionKey: 'document-key' },
  legacy: { tenancy, legacyDataTenantIds: ['B'], allowEditingLegacyData: true, ...options },
  draft: {
    schemaVersion: 1,
    revision: 0,
    ownership: { enabled: tenancy !== 'shared' },
    rules: [
      { id: 'legacy-mode', category: 'ownership', enabled: true },
      ...(tenancy !== 'shared'
        ? [
            { id: 'legacy-data-visibility', category: 'visibility', enabled: true },
            { id: 'legacy-data-ownership', category: 'ownership', enabled: true },
          ]
        : []),
    ],
  },
  roleScopes: [
    { role: 'manager', action: 'list', resource: 'documents', treatment: 'delegate-builtin-scope' },
    { role: 'manager', action: 'update', resource: 'documents', treatment: 'retain-role-scope' },
    { role: 'manager', action: 'create', resource: 'documents', treatment: 'no-direct-resource-grant' },
  ],
});

function fixture(request = vi.fn().mockResolvedValue({ data: { data: report() } })) {
  const api = { auth: { role: 'manager' as string | undefined }, request };
  const close = vi.fn();
  const view = (selected = collection) => (
    <APIClientProvider apiClient={api as never}>
      <TenantMigrationPreview collection={selected} tenants={tenants} onClose={close} />
    </APIClientProvider>
  );
  return { api, request, close, view };
}

describe('tenant migration preview drawer', () => {
  it('requests the authoritative preview and selected role actions without writing', async () => {
    const { request, view } = fixture();
    const { findByText, queryByRole } = render(view());
    await findByText('Ownership rules');
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][0]).toMatchObject({
      url: 'tenants:previewAccessMigration',
      method: 'post',
      headers: { 'X-Data-Source': 'main' },
      skipNotify: true,
      data: {
        dataSourceKey: 'main',
        collectionName: 'documents',
        roleActions: ['list', 'create', 'update', 'destroy'].map((action) => ({ role: 'manager', action })),
      },
    });
    expect(queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(queryByRole('button', { name: 'Enable' })).not.toBeInTheDocument();
  });

  it.each([
    ['shared', 'All records remain subject to role permissions.'],
    ['tenantScoped', 'Records owned by the current tenant remain subject to role permissions.'],
    ['tenantInherited', 'Records owned by the current tenant or its descendants remain subject to role permissions.'],
  ])('explains the %s ownership range using the server response', async (tenancy, text) => {
    const { view } = fixture(vi.fn().mockResolvedValue({ data: { data: report(tenancy) } }));
    const { findByText, queryByText } = render(view());
    await findByText(text);
    if (tenancy === 'shared') {
      expect(queryByText('Branch B (B)')).not.toBeInTheDocument();
      expect(queryByText('Allowed edits claim legacy records for the first editor’s tenant.')).not.toBeInTheDocument();
    }
  });

  it('distinguishes visibility from ownership and identifies legacy tenants by name and ID', async () => {
    const { view } = fixture();
    const { findByText, getByText } = render(view());
    await findByText('Branch B (B)');
    expect(getByText('Visibility rules never grant editing or deletion.')).toBeInTheDocument();
    expect(getByText('Allowed edits claim legacy records for the first editor’s tenant.')).toBeInTheDocument();
    expect(getByText('The new rules can take over the built-in tenant condition.')).toBeInTheDocument();
    expect(getByText('Keep existing role conditions.')).toBeInTheDocument();
    expect(getByText('No separate collection grant.')).toBeInTheDocument();
  });

  it('does not promise legacy editing when the switch is off', async () => {
    const readonly = report('tenantScoped', { allowEditingLegacyData: false });
    readonly.draft.rules = readonly.draft.rules.filter((rule) => rule.id !== 'legacy-data-ownership');
    const { view } = fixture(vi.fn().mockResolvedValue({ data: { data: readonly } }));
    const { findByText, queryByText } = render(view());
    await findByText('Legacy records remain read-only.');
    expect(queryByText('Allowed edits claim legacy records for the first editor’s tenant.')).not.toBeInTheDocument();
  });

  it('does not promise legacy access when no tenant is listed', async () => {
    const { view } = fixture(
      vi.fn().mockResolvedValue({ data: { data: report('tenantScoped', { legacyDataTenantIds: [] }) } }),
    );
    const { findByText, queryByText } = render(view());
    await findByText('No additional legacy data access is granted.');
    expect(queryByText('Allowed edits claim legacy records for the first editor’s tenant.')).not.toBeInTheDocument();
  });

  it('does not guess a missing current role', async () => {
    const { api, request, view } = fixture(
      vi.fn().mockResolvedValue({ data: { data: { ...report(), roleScopes: [] } } }),
    );
    api.auth.role = undefined;
    const { findByText } = render(view());
    await findByText('No current role was available, so role conditions were not inspected.');
    expect(request.mock.calls[0][0].data.roleActions).toEqual([]);
  });

  it('shows the server error and retries without showing stale results', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: { data: report() } })
      .mockRejectedValueOnce({
        response: { status: 409, data: { errors: [{ message: 'Settings changed. Refresh.' }] } },
      })
      .mockResolvedValueOnce({ data: { data: report('shared') } });
    const { view } = fixture(request);
    const { findByText, getByRole, queryByText } = render(view());
    await findByText('Branch B (B)');
    fireEvent.click(getByRole('button', { name: 'Refresh preview' }));
    await findByText('Settings changed. Refresh.');
    expect(queryByText('Branch B (B)')).not.toBeInTheDocument();
    fireEvent.click(getByRole('button', { name: 'Refresh preview' }));
    await findByText('All records remain subject to role permissions.');
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('shows a friendly fallback for unexpected client errors', async () => {
    const { view } = fixture(vi.fn().mockRejectedValue(new Error('TypeError: internal details')));
    const { findByText, queryByText } = render(view());
    await findByText('Migration preview failed. Refresh to try again.');
    expect(queryByText('TypeError: internal details')).not.toBeInTheDocument();
  });

  it('does not expose unexpected server error details', async () => {
    const { view } = fixture(
      vi.fn().mockRejectedValue({
        response: { status: 500, data: { errors: [{ message: 'TypeError: internal details' }] } },
      }),
    );
    const { findByText, queryByText } = render(view());
    await findByText('Migration preview failed. Refresh to try again.');
    expect(queryByText('TypeError: internal details')).not.toBeInTheDocument();
  });

  it('discards an older response after changing the selected table', async () => {
    let resolveOld: (value: unknown) => void;
    const request = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (resolveOld = resolve)))
      .mockResolvedValueOnce({
        data: { data: { ...report('shared'), identity: { ...report().identity, collectionName: 'other' } } },
      });
    const { view } = fixture(request);
    const { rerender, findByText, queryByText } = render(view());
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    rerender(view({ name: 'other', title: 'Other' }));
    await findByText('All records remain subject to role permissions.');
    await act(async () => resolveOld!({ data: { data: report() } }));
    expect(queryByText('Branch B (B)')).not.toBeInTheDocument();
  });

  it('aborts a pending request on unmount and ignores its eventual response', async () => {
    let resolveRequest: (value: unknown) => void;
    const { request, view } = fixture(vi.fn(() => new Promise((resolve) => (resolveRequest = resolve))));
    const { unmount } = render(view());
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    const signal = request.mock.calls[0][0].signal as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => resolveRequest!({ data: { data: report() } }));
  });

  it('does not show a report for a different table identity', async () => {
    const result = report();
    result.identity.collectionName = 'wrong';
    const { view } = fixture(vi.fn().mockResolvedValue({ data: { data: result } }));
    const { findByText, queryByText } = render(view());
    await findByText('Migration preview failed. Refresh to try again.');
    expect(queryByText('Ownership rules')).not.toBeInTheDocument();
  });
});

import React from 'react';
import { APIClientProvider } from '@tachybase/client';
import { act, fireEvent, render, waitFor } from '@tachybase/test/client';

import type { AccessConfig } from '../../server/access-control/types';
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
      {
        id: 'legacy-mode',
        name: 'Legacy mode',
        category: 'ownership',
        enabled: true,
        subject: { type: 'constant', value: true },
        condition: { type: 'constant', value: false },
      },
      ...(tenancy !== 'shared'
        ? [
            {
              id: 'legacy-data-visibility',
              name: 'Legacy visibility',
              category: 'visibility',
              enabled: true,
              subject: { type: 'constant', value: false },
              condition: { type: 'constant', value: true },
            },
            {
              id: 'legacy-data-ownership',
              name: 'Legacy ownership',
              category: 'ownership',
              enabled: true,
              subject: { type: 'constant', value: false },
              condition: { type: 'constant', value: true },
            },
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
  it('shows file-content boundaries for file tables and clears the notice for other tables', async () => {
    const { view } = fixture();
    const selected = { ...collection, template: 'file' };
    const { findByText, queryByText, rerender } = render(view(selected));
    const notice =
      'These rules restrict attachment records, not public file links. File-content isolation also requires controlled downloads.';
    await findByText(notice);
    rerender(view(collection));
    expect(queryByText(notice)).not.toBeInTheDocument();
  });

  it.each(['shared', 'tenantScoped', 'tenantInherited'])(
    'edits and validates a disposable %s migration draft',
    async (mode) => {
      const original = report(mode);
      const snapshot = JSON.parse(JSON.stringify(original));
      const request = vi
        .fn()
        .mockResolvedValueOnce({ data: { data: original } })
        .mockImplementation(async ({ data }) => ({
          data: { data: { identity: original.identity, config: data.config } },
        }));
      const { view } = fixture(request);
      const { findByText, getByRole, getAllByRole, queryByRole } = render(view());
      expect(queryByRole('button', { name: 'Edit migration draft' })).not.toBeInTheDocument();
      await findByText('This is a migration draft. No new rules have been saved or enabled.');
      fireEvent.click(await findByText('Edit migration draft'));
      expect(getByRole('switch', { name: 'Manage actual tenant ownership' })).toHaveAttribute(
        'aria-checked',
        String(mode !== 'shared'),
      );
      fireEvent.change(getAllByRole('textbox', { name: 'Rule name' })[0], { target: { value: 'Adjusted rule' } });
      expect(request).toHaveBeenCalledOnce();
      fireEvent.click(getByRole('button', { name: 'Validate draft' }));
      await findByText('Draft validation passed. Changes have not been saved or enabled.');
      expect(request.mock.calls[1][0]).toMatchObject({
        url: 'tenants:validateAccessConfig',
        method: 'post',
        data: {
          dataSourceKey: 'main',
          collectionName: 'documents',
          config: {
            ...original.draft,
            rules: original.draft.rules.map((rule, index) => (index === 0 ? { ...rule, name: 'Adjusted rule' } : rule)),
          },
        },
      });
      expect(original).toEqual(snapshot);
      fireEvent.click(getByRole('button', { name: 'Discard draft' }));
      fireEvent.click(getByRole('button', { name: 'Edit migration draft' }));
      expect(getAllByRole('textbox', { name: 'Rule name' })[0]).toHaveValue('Legacy mode');
      expect(request).toHaveBeenCalledTimes(2);
      expect(queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    },
  );

  it.each(['refresh', 'role', 'collection', 'close'])('discards pending migration validation on %s', async (change) => {
    let finish!: (value: unknown) => void;
    let submitted!: AccessConfig;
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: { data: report('shared') } })
      .mockImplementationOnce(({ data }) => {
        submitted = data.config;
        return new Promise((resolve) => {
          finish = resolve;
        });
      })
      .mockResolvedValue({ data: { data: report('shared') } });
    const { api, view } = fixture(request);
    const { findByText, getByRole, queryByRole, queryByText, rerender, unmount } = render(view());
    await findByText('All records remain subject to role permissions.');
    fireEvent.click(getByRole('button', { name: 'Edit migration draft' }));
    fireEvent.click(getByRole('button', { name: 'Validate draft' }));
    const signal = request.mock.calls[1][0].signal as AbortSignal;
    if (change === 'refresh') fireEvent.click(getByRole('button', { name: 'Refresh preview' }));
    else if (change === 'role') {
      api.auth.role = 'other';
      rerender(view());
    } else if (change === 'collection') rerender(view({ name: 'other', title: 'Other' }));
    else unmount();
    expect(signal.aborted).toBe(true);
    expect(queryByRole('textbox', { name: 'Rule name' })).not.toBeInTheDocument();
    await act(async () => finish({ data: { data: { identity: report().identity, config: submitted } } }));
    expect(queryByText('Draft validation passed. Changes have not been saved or enabled.')).not.toBeInTheDocument();
    if (change === 'role') {
      await findByText('All records remain subject to role permissions.');
      api.auth.role = 'manager';
      rerender(view());
      await findByText('All records remain subject to role permissions.');
      expect(queryByRole('textbox', { name: 'Rule name' })).not.toBeInTheDocument();
    }
  });

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

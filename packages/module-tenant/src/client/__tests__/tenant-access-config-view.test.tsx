import React from 'react';
import { APIClientProvider } from '@tachybase/client';
import { act, fireEvent, render, waitFor } from '@tachybase/test/client';

import type { AccessCondition, AccessConfig, AccessRule } from '../../server/access-control/types';
import { TenantAccessConfigView } from '../TenantAccessConfigView';

const collection = { name: 'documents', title: 'Documents' };
const constant: AccessCondition = { type: 'constant', value: true };
const rule: AccessRule = {
  id: 'visible',
  name: 'Branch documents',
  category: 'visibility',
  enabled: false,
  subject: {
    type: 'compare',
    operator: 'eq',
    left: { type: 'context', path: 'tenant.id' },
    right: { type: 'literal', value: 'B' },
  },
  condition: { type: 'isNull', operand: { type: 'field', path: 'tenantId' } },
};
const config: AccessConfig = { schemaVersion: 1, revision: 7, ownership: { enabled: true }, rules: [rule] };
const report = (value: AccessConfig | null = config, name = 'documents', source = 'main') => ({
  data: {
    data: { identity: { dataSourceKey: source, collectionName: name, collectionKey: `${name}-key` }, config: value },
  },
});

function fixture(request = vi.fn().mockResolvedValue(report())) {
  const api = { auth: { role: 'manager' }, request };
  const close = vi.fn();
  const view = (selected = collection) => (
    <APIClientProvider apiClient={api as never}>
      <TenantAccessConfigView collection={selected} onClose={close} />
    </APIClientProvider>
  );
  return { api, request, close, view };
}

describe('saved tenant access rules', () => {
  it('starts an unconfigured collection with a disposable empty draft at revision zero', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(report(null))
      .mockImplementation(async ({ data }) => report(data.config));
    const { view } = fixture(request);
    const { findByText, getByRole, queryByRole } = render(view());
    expect(queryByRole('button', { name: 'Create rule draft' })).not.toBeInTheDocument();
    await findByText('No access rules have been saved for this collection.');
    fireEvent.click(getByRole('button', { name: 'Create rule draft' }));
    expect(getByRole('switch', { name: 'Manage actual tenant ownership' })).toBeChecked();
    expect(queryByRole('textbox', { name: 'Rule name' })).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledOnce();
    fireEvent.click(getByRole('button', { name: 'Validate draft' }));
    await findByText('Draft validation passed. Changes have not been saved or enabled.');
    expect(request.mock.calls[1][0]).toMatchObject({
      url: 'tenants:validateAccessConfig',
      data: {
        dataSourceKey: 'main',
        collectionName: 'documents',
        config: {
          schemaVersion: 1,
          revision: 0,
          ownership: { enabled: true },
          rules: [],
        },
      },
    });
    fireEvent.click(getByRole('button', { name: 'Add rule' }));
    fireEvent.click(getByRole('button', { name: 'Discard draft' }));
    fireEvent.click(getByRole('button', { name: 'Create rule draft' }));
    expect(queryByRole('textbox', { name: 'Rule name' })).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('discards a pending draft when the active role changes', async () => {
    let resolveValidation!: (value: unknown) => void;
    const request = vi
      .fn()
      .mockResolvedValueOnce(report())
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveValidation = resolve;
          }),
      )
      .mockResolvedValue(report());
    const { api, view } = fixture(request);
    const { findByText, getByRole, rerender, queryByRole, queryByText } = render(view());
    await findByText('Branch documents');
    fireEvent.click(getByRole('button', { name: 'Edit rule draft' }));
    fireEvent.click(getByRole('button', { name: 'Validate draft' }));
    const signal = request.mock.calls[1][0].signal as AbortSignal;
    api.auth.role = 'other-manager';
    rerender(view());
    expect(signal.aborted).toBe(true);
    expect(queryByRole('textbox', { name: 'Rule name' })).not.toBeInTheDocument();
    await findByText('Branch documents');
    await act(async () => resolveValidation(report()));
    expect(queryByText('Draft validation passed. Changes have not been saved or enabled.')).not.toBeInTheDocument();
    api.auth.role = 'manager';
    rerender(view());
    await findByText('Branch documents');
    expect(queryByRole('textbox', { name: 'Rule name' })).not.toBeInTheDocument();
  });

  it('opens a disposable draft, refreshes saved rules and discards unsaved changes', async () => {
    const { request, view } = fixture();
    const { findByText, getByRole, queryByRole } = render(view());
    await findByText('Branch documents');
    fireEvent.click(getByRole('button', { name: 'Edit rule draft' }));
    fireEvent.change(getByRole('textbox', { name: 'Rule name' }), { target: { value: 'Unsaved' } });
    expect(request).toHaveBeenCalledOnce();
    fireEvent.click(getByRole('button', { name: 'Refresh saved rules' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await findByText('Branch documents');
    expect(queryByRole('textbox', { name: 'Rule name' })).not.toBeInTheDocument();
    fireEvent.click(getByRole('button', { name: 'Edit rule draft' }));
    expect(getByRole('textbox', { name: 'Rule name' })).toHaveValue('Branch documents');
    fireEvent.click(getByRole('button', { name: 'Discard draft' }));
    expect(queryByRole('textbox', { name: 'Rule name' })).not.toBeInTheDocument();
  });

  it('reads saved rules and version without exposing save or activation controls', async () => {
    const { request, view } = fixture();
    const { findByText, getByText, queryByRole } = render(view());
    await findByText('Branch documents');
    expect(getByText('7')).toBeInTheDocument();
    expect(getByText('1')).toBeInTheDocument();
    expect(getByText('Disabled')).toBeInTheDocument();
    expect(getByText('Visibility rules never grant editing or deletion.')).toBeInTheDocument();
    expect(
      getByText(
        'Saved rules are shown for inspection only. This view does not enable them or verify their use in business requests.',
      ),
    ).toBeInTheDocument();
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][0]).toMatchObject({
      url: 'tenants:readAccessConfig',
      method: 'post',
      headers: { 'X-Data-Source': 'main' },
      skipNotify: true,
      data: { dataSourceKey: 'main', collectionName: 'documents' },
    });
    expect(queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(queryByRole('switch')).not.toBeInTheDocument();
  });

  it('distinguishes no saved configuration from a saved configuration with no rules', async () => {
    const { request, view } = fixture(
      vi
        .fn()
        .mockResolvedValueOnce(report(null))
        .mockResolvedValueOnce(report({ ...config, rules: [] })),
    );
    const { findByText, getByRole, queryByText } = render(view());
    await findByText('No access rules have been saved for this collection.');
    expect(queryByText('Configuration revision')).not.toBeInTheDocument();
    fireEvent.click(getByRole('button', { name: 'Refresh saved rules' }));
    await findByText('No rules in this saved configuration.');
    expect(queryByText('Configuration revision')).toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('shows visitor and record conditions including nested associations and logical groups', async () => {
    const nested: AccessCondition = {
      type: 'all',
      children: [
        { type: 'any', children: [constant, { type: 'constant', value: false }] },
        { type: 'not', child: { type: 'isNull', operand: { type: 'field', path: 'tenantId' } } },
        {
          type: 'exists',
          path: 'customers',
          condition: {
            type: 'compare',
            operator: 'in',
            left: { type: 'field', path: 'id' },
            right: { type: 'literal', value: [1, 2] },
          },
        },
      ],
    };
    const { view } = fixture(vi.fn().mockResolvedValue(report({ ...config, rules: [{ ...rule, subject: nested }] })));
    const { findByText, getByText } = render(view());
    await findByText('All conditions must match');
    for (const label of [
      'Visitor conditions',
      'Record conditions',
      'Any condition may match',
      'Always matches',
      'Never matches',
      'Must not match',
      'At least one related record matches: customers',
      'Field: id is one of [1,2]',
    ]) {
      expect(getByText(label)).toBeInTheDocument();
    }
  });

  it.each([
    ['same', true, 'Current tenant is the specified tenant'],
    ['ancestor', false, 'Current tenant is an ancestor of the specified tenant'],
    ['descendant', true, 'Current tenant is a descendant of the specified tenant, or is that tenant'],
  ] as const)('explains %s direction relative to the current tenant', async (relation, includeSelf, label) => {
    const { view } = fixture(
      vi.fn().mockResolvedValue(
        report({
          ...config,
          rules: [
            {
              ...rule,
              condition: {
                type: 'tenantRelation',
                tenant: { type: 'field', path: 'tenantId' },
                relation,
                includeSelf,
              },
            },
          ],
        }),
      ),
    );
    const { findByText } = render(view());
    await findByText(`${label}: Field: tenantId`);
  });

  it('clears stale rules on refresh, shows expected errors and can retry', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(report())
      .mockRejectedValueOnce({ response: { status: 409, data: { errors: [{ message: 'Rules changed. Refresh.' }] } } })
      .mockResolvedValueOnce(report(null));
    const { view } = fixture(request);
    const { findByText, getByRole, queryByText } = render(view());
    await findByText('Branch documents');
    fireEvent.click(getByRole('button', { name: 'Refresh saved rules' }));
    await findByText('Rules changed. Refresh.');
    expect(queryByText('Branch documents')).not.toBeInTheDocument();
    fireEvent.click(getByRole('button', { name: 'Refresh saved rules' }));
    await findByText('No access rules have been saved for this collection.');
  });

  it('preserves the empty-tenant caveat when negating an empty relationship set', async () => {
    const { view } = fixture(
      vi.fn().mockResolvedValue(
        report({
          ...config,
          rules: [
            {
              ...rule,
              condition: {
                type: 'not',
                child: {
                  type: 'tenantRelation',
                  tenant: { type: 'field', path: 'tenantId' },
                  relation: 'same',
                  includeSelf: false,
                },
              },
            },
          ],
        }),
      ),
    );
    const { findByText, getByText } = render(view());
    await findByText(
      'No tenant relationship matches: Field: tenantId. If the tenant is empty, neither this condition nor its negation matches.',
    );
    expect(getByText('Must not match')).toBeInTheDocument();
  });

  it.each([
    new Error('internal details'),
    { response: { status: 500, data: { errors: [{ message: 'internal details' }] } } },
  ])('hides unexpected error details', async (error) => {
    const { view } = fixture(vi.fn().mockRejectedValue(error));
    const { findByText, queryByText } = render(view());
    await findByText('Unable to load saved rules. Refresh to try again.');
    expect(queryByText('internal details')).not.toBeInTheDocument();
  });

  it.each([
    ['wrong', 'main'],
    ['documents', 'external'],
  ])('rejects mismatching response identity %s/%s', async (name, source) => {
    const { view } = fixture(vi.fn().mockResolvedValue(report(config, name, source)));
    const { findByText, queryByText } = render(view());
    await findByText('Unable to load saved rules. Refresh to try again.');
    expect(queryByText('Branch documents')).not.toBeInTheDocument();
  });

  it('ignores an older response after switching collections', async () => {
    let resolveOld!: (value: unknown) => void;
    const request = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (resolveOld = resolve)))
      .mockResolvedValueOnce(report(null, 'other'));
    const { view } = fixture(request);
    const { rerender, findByText, queryByText } = render(view());
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    rerender(view({ name: 'other', title: 'Other' }));
    await findByText('No access rules have been saved for this collection.');
    await act(async () => resolveOld(report()));
    expect(queryByText('Branch documents')).not.toBeInTheDocument();
  });

  it('hides the previous role result and ignores pending responses when closed', async () => {
    let resolveNext!: (value: unknown) => void;
    const request = vi
      .fn()
      .mockResolvedValueOnce(report())
      .mockImplementationOnce(() => new Promise((resolve) => (resolveNext = resolve)));
    const { api, view } = fixture(request);
    const { rerender, findByText, queryByText, unmount } = render(view());
    await findByText('Branch documents');
    api.auth.role = 'viewer';
    rerender(view());
    expect(queryByText('Branch documents')).not.toBeInTheDocument();
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    const signal = request.mock.calls[1][0].signal as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => resolveNext(report()));
  });
});

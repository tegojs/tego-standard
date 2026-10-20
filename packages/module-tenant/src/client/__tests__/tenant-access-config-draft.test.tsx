import React from 'react';
import { APIClientProvider } from '@tachybase/client';
import { act, fireEvent, render } from '@tachybase/test/client';

import type { AccessConfig } from '../../server/access-control/types';
import { TenantAccessConfigDraft } from '../TenantAccessConfigDraft';

const identity = { dataSourceKey: 'main', collectionName: 'documents', collectionKey: 'documents-key' };
const config: AccessConfig = {
  schemaVersion: 1,
  revision: 7,
  ownership: { enabled: true },
  rules: [
    {
      id: 'branch',
      name: 'Branch documents',
      enabled: true,
      category: 'visibility',
      subject: { type: 'constant', value: true },
      condition: { type: 'isNull', operand: { type: 'field', path: 'tenantId' } },
    },
  ],
};

function fixture(
  request = vi.fn().mockImplementation(async ({ data }) => ({ data: { data: { identity, config: data.config } } })),
) {
  const api = { auth: { role: 'manager' }, request };
  const close = vi.fn();
  const view = () => (
    <APIClientProvider apiClient={api as never}>
      <TenantAccessConfigDraft identity={identity} config={config} onClose={close} />
    </APIClientProvider>
  );
  return { request, close, view };
}

describe('tenant access rule draft', () => {
  it('edits a local copy, preserves rule conditions and base revision, and only validates', async () => {
    const { request, view } = fixture();
    const { getByRole, findByText, queryByRole } = render(view());
    fireEvent.change(getByRole('textbox', { name: 'Rule name' }), { target: { value: 'Renamed' } });
    fireEvent.click(getByRole('switch', { name: 'Manage actual tenant ownership' }));
    fireEvent.click(getByRole('switch', { name: 'Rule enabled' }));
    fireEvent.mouseDown(getByRole('combobox', { name: 'Rule category' }));
    fireEvent.click(await findByText('Ownership rules'));
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(getByRole('button', { name: 'Validate draft' }));
    await findByText('Draft validation passed. Changes have not been saved or enabled.');
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][0]).toMatchObject({
      url: 'tenants:validateAccessConfig',
      method: 'post',
      headers: { 'X-Data-Source': 'main' },
      skipNotify: true,
      data: {
        dataSourceKey: 'main',
        collectionName: 'documents',
        config: {
          ...config,
          ownership: { enabled: false },
          rules: [{ ...config.rules[0], name: 'Renamed', enabled: false, category: 'ownership' }],
        },
      },
    });
    expect(config.rules[0].name).toBe('Branch documents');
    expect(config.rules[0].enabled).toBe(true);
    expect(config.ownership.enabled).toBe(true);
    expect(queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('clears successful validation after the next edit and discards without a request', async () => {
    const { request, close, view } = fixture();
    const { getByRole, findByText, queryByText } = render(view());
    fireEvent.click(getByRole('button', { name: 'Validate draft' }));
    await findByText('Draft validation passed. Changes have not been saved or enabled.');
    fireEvent.change(getByRole('textbox', { name: 'Rule name' }), { target: { value: 'Changed' } });
    expect(queryByText('Draft validation passed. Changes have not been saved or enabled.')).not.toBeInTheDocument();
    fireEvent.click(getByRole('button', { name: 'Discard draft' }));
    expect(close).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
  });

  it('accepts equivalent JSON with a different property order', async () => {
    const { view } = fixture(
      vi.fn().mockResolvedValue({
        data: {
          data: {
            identity: {
              collectionKey: identity.collectionKey,
              collectionName: identity.collectionName,
              dataSourceKey: 'main',
            },
            config: { rules: config.rules, ownership: config.ownership, revision: 7, schemaVersion: 1 },
          },
        },
      }),
    );
    const { getByRole, findByText } = render(view());
    fireEvent.click(getByRole('button', { name: 'Validate draft' }));
    await findByText('Draft validation passed. Changes have not been saved or enabled.');
  });

  it('disables all editing controls and prevents duplicate requests while validation is pending', async () => {
    const { request, view } = fixture(vi.fn().mockReturnValue(new Promise(() => {})));
    const { getByRole } = render(view());
    fireEvent.click(getByRole('button', { name: 'Validate draft' }));
    expect(getByRole('textbox', { name: 'Rule name' })).toBeDisabled();
    expect(getByRole('switch', { name: 'Manage actual tenant ownership' })).toBeDisabled();
    expect(getByRole('switch', { name: 'Rule enabled' })).toBeDisabled();
    expect(getByRole('combobox', { name: 'Rule category' })).toBeDisabled();
    fireEvent.click(getByRole('button', { name: 'Validate draft' }));
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([409, 403, 400])('shows the server explanation for HTTP %s', async (status) => {
    const { view } = fixture(
      vi.fn().mockRejectedValue({ response: { status, data: { errors: [{ message: 'Refresh required' }] } } }),
    );
    const { getByRole, findByText } = render(view());
    fireEvent.click(getByRole('button', { name: 'Validate draft' }));
    await findByText('Refresh required');
    expect(getByRole('textbox', { name: 'Rule name' })).not.toBeDisabled();
  });

  it('hides unexpected error details and allows retry', async () => {
    const { request, view } = fixture(
      vi
        .fn()
        .mockRejectedValueOnce(new Error('internal detail'))
        .mockImplementation(async ({ data }) => ({ data: { data: { identity, config: data.config } } })),
    );
    const { getByRole, findByText, queryByText } = render(view());
    fireEvent.click(getByRole('button', { name: 'Validate draft' }));
    await findByText('Unable to validate the draft. Please try again.');
    expect(queryByText('internal detail')).not.toBeInTheDocument();
    fireEvent.click(getByRole('button', { name: 'Validate draft' }));
    await findByText('Draft validation passed. Changes have not been saved or enabled.');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(['identity', 'config'])('rejects a validation response with mismatched %s', async (field) => {
    const value = {
      identity,
      config,
      [field]: field === 'identity' ? { ...identity, collectionKey: 'recreated' } : { ...config, revision: 8 },
    };
    const { view } = fixture(vi.fn().mockResolvedValue({ data: { data: value } }));
    const { getByRole, findByText } = render(view());
    fireEvent.click(getByRole('button', { name: 'Validate draft' }));
    await findByText('Unable to validate the draft. Please try again.');
  });

  it('aborts validation when the draft is discarded and ignores late responses', async () => {
    let resolve!: (value: unknown) => void;
    const { request, close, view } = fixture(
      vi.fn().mockReturnValue(
        new Promise((done) => {
          resolve = done;
        }),
      ),
    );
    const { getByRole, unmount } = render(view());
    fireEvent.click(getByRole('button', { name: 'Validate draft' }));
    const signal = request.mock.calls[0][0].signal;
    fireEvent.click(getByRole('button', { name: 'Discard draft' }));
    expect(close).toHaveBeenCalledOnce();
    expect(signal.aborted).toBe(true);
    unmount();
    await act(async () => resolve({ data: { data: { identity, config } } }));
  });
});

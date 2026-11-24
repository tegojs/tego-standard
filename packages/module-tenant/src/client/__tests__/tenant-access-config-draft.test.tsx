import React from 'react';
import { APIClientProvider } from '@tachybase/client';
import { act, fireEvent, render } from '@tachybase/test/client';

import { vi } from 'vitest';

import type { AccessConfig } from '../../server/access-control/types';
import { TenantAccessConfigDraft } from '../TenantAccessConfigDraft';

vi.setConfig({ testTimeout: 60000 });

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
  initialConfig = config,
) {
  const api = { auth: { role: 'manager' }, request };
  const close = vi.fn();
  const saved = vi.fn();
  const view = () => (
    <APIClientProvider apiClient={api as never}>
      <TenantAccessConfigDraft identity={identity} config={initialConfig} onClose={close} onSaved={saved} />
    </APIClientProvider>
  );
  return { request, close, saved, view };
}

describe('tenant access rule draft', () => {
  it('adds disabled non-matching rules with stable unique IDs without automatic requests', async () => {
    const initial = { ...config, rules: [{ ...config.rules[0], id: 'rule-1' }] };
    const { request, view } = fixture(undefined, initial);
    const { getByRole, findByText, queryByText } = render(view());
    fireEvent.click(getByRole('button', { name: 'Add rule' }));
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(getByRole('button', { name: 'Validate draft' }));
    await findByText('Draft validation passed. Changes have not been saved or enabled.');
    const added = request.mock.calls[0][0].data.config.rules[1];
    expect(added).toMatchObject({
      name: 'New rule',
      enabled: false,
      category: 'visibility',
      subject: { type: 'constant', value: false },
      condition: { type: 'constant', value: false },
    });
    expect(added.id).not.toBe('rule-1');
    fireEvent.click(getByRole('button', { name: `Remove rule ${added.id}` }));
    expect(queryByText('Draft validation passed. Changes have not been saved or enabled.')).not.toBeInTheDocument();
    fireEvent.click(getByRole('button', { name: 'Validate draft' }));
    await findByText('Draft validation passed. Changes have not been saved or enabled.');
    expect(request.mock.calls[1][0].data.config.rules).toEqual(initial.rules);
    fireEvent.click(getByRole('button', { name: 'Add rule' }));
    expect(queryByText('Draft validation passed. Changes have not been saved or enabled.')).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(2);
    fireEvent.click(getByRole('button', { name: 'Validate draft' }));
    await findByText('Draft validation passed. Changes have not been saved or enabled.');
    const next = request.mock.calls[2][0].data.config;
    expect(next.revision).toBe(7);
    expect(next.rules[0]).toEqual(initial.rules[0]);
    expect(next.rules[1].id).not.toBe(added.id);
    expect(next.rules[1].id).not.toBe('rule-1');
    expect(initial.rules).toHaveLength(1);
  });

  it('presents a clear rule list, selected rule editor, and save action', () => {
    const { view } = fixture();
    const { getByRole, getByText } = render(view());

    expect(getByText('Rules')).toBeInTheDocument();
    expect(getByText('Selected rule')).toBeInTheDocument();
    expect(getByText('Ownership setting')).toBeInTheDocument();
    expect(getByText('Controls whether this model manages the actual tenantId ownership field.')).toBeInTheDocument();
    expect(getByRole('button', { name: 'Save rules' })).toBeInTheDocument();
    expect(getByText('Branch documents')).toBeInTheDocument();
    expect(getByRole('button', { name: 'Branch documents Enabled' })).toHaveAttribute('aria-pressed', 'true');
    expect(getByRole('button', { name: 'Branch documents Enabled' })).toBeInTheDocument();
  });

  it('saves the draft through the audited action and reports the persisted revision', async () => {
    const request = vi.fn().mockImplementation(async ({ data }) => ({
      data: { data: { identity, config: { ...data.config, revision: data.config.revision + 1 } } },
    }));
    const { view, saved } = fixture(request);
    const { getByRole, findByText } = render(view());

    fireEvent.click(getByRole('button', { name: 'Save rules' }));

    await findByText('Rules saved as revision 8.');
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ url: 'tenants:saveAccessConfig' }));
    expect(saved).toHaveBeenCalledWith({ ...config, revision: 8 });
  });

  it('keeps the save dialog open while the server write is pending', () => {
    const request = vi.fn().mockReturnValue(new Promise(() => {}));
    const { view } = fixture(request);
    const { getByRole } = render(view());

    fireEvent.click(getByRole('button', { name: 'Save rules' }));

    expect(getByRole('button', { name: 'Discard draft' })).toBeDisabled();
    expect(getByRole('button', { name: 'loading Save rules' })).toBeDisabled();
  });

  it('removes the last rule locally and validates an empty rule list', async () => {
    const { request, view } = fixture();
    const { getByRole, findByText, queryByRole } = render(view());
    fireEvent.click(getByRole('button', { name: 'Remove rule branch' }));
    expect(queryByRole('textbox', { name: 'Rule name' })).not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(getByRole('button', { name: 'Validate draft' }));
    await findByText('Draft validation passed. Changes have not been saved or enabled.');
    expect(request.mock.calls[0][0].data.config).toEqual({ ...config, rules: [] });
    expect(config.rules).toHaveLength(1);
  });

  it('limits the draft to 100 rules and allows adding after removal', () => {
    const rules = Array.from({ length: 100 }, (_, index) => ({
      ...config.rules[0],
      id: `rule-${index}`,
      subject: { type: 'constant' as const, value: false },
      condition: { type: 'constant' as const, value: false },
    }));
    const { request, view } = fixture(undefined, { ...config, rules });
    const { container, getAllByRole, getByRole } = render(view());
    const add = () =>
      Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Add rule');
    expect(add()).toBeDisabled();
    fireEvent.click(getAllByRole('button', { name: 'Branch documents Enabled' })[0]);
    fireEvent.click(getByRole('button', { name: 'Remove rule rule-0' }));
    expect(add()).not.toBeDisabled();
    fireEvent.click(add()!);
    expect(add()).toBeDisabled();
    expect(request).not.toHaveBeenCalled();
  });

  it('validates edited record conditions and clears an earlier validation result', async () => {
    const { request, view } = fixture();
    const { getByRole, findByText, queryByText } = render(view());
    fireEvent.click(getByRole('button', { name: 'Validate draft' }));
    await findByText('Draft validation passed. Changes have not been saved or enabled.');
    fireEvent.change(getByRole('textbox', { name: 'Record conditions / Field path' }), {
      target: { value: 'projectId' },
    });
    expect(queryByText('Draft validation passed. Changes have not been saved or enabled.')).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledOnce();
    fireEvent.click(getByRole('button', { name: 'Validate draft' }));
    await findByText('Draft validation passed. Changes have not been saved or enabled.');
    expect(request.mock.calls[1][0].data.config.rules[0].condition).toEqual({
      type: 'isNull',
      operand: { type: 'field', path: 'projectId' },
    });
    expect(config.rules[0].condition).toEqual({ type: 'isNull', operand: { type: 'field', path: 'tenantId' } });
  });

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
    expect(getByRole('textbox', { name: 'Record conditions / Field path' })).toBeDisabled();
    expect(getByRole('button', { name: 'Add rule' })).toBeDisabled();
    expect(getByRole('button', { name: 'Remove rule branch' })).toBeDisabled();
    expect(getByRole('button', { name: 'Discard draft' })).not.toBeDisabled();
    fireEvent.click(getByRole('button', { name: /Validate draft/ }));
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

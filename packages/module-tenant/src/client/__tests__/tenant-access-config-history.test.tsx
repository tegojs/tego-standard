import React from 'react';
import { APIClientProvider } from '@tachybase/client';
import { act, fireEvent, render, waitFor } from '@tachybase/test/client';

import type { AccessConfig } from '../../server/access-control/types';
import { TenantAccessConfigView } from '../TenantAccessConfigView';

const identity = { dataSourceKey: 'main', collectionName: 'documents', collectionKey: 'documents-key' };
const config: AccessConfig = { schemaVersion: 1, revision: 7, ownership: { enabled: true }, rules: [] };
const restored: AccessConfig = {
  ...config,
  rules: [
    {
      id: 'old',
      name: 'Historical rule',
      category: 'visibility',
      enabled: false,
      subject: { type: 'constant', value: true },
      condition: { type: 'constant', value: false },
    },
  ],
};
const response = (data: unknown) => ({ data: { data } });
const page = (revision = 7, nextBefore: number | null = null) => ({
  identity,
  revisions: [{ revision, actorUserId: '28', savedAt: '2026-11-02T07:00:00.000Z' }],
  nextBefore,
});
const preview = () => ({ identity, sourceRevision: 3, config: restored });

interface Request {
  url: string;
  data: { collectionName: string; beforeRevision?: number; config?: AccessConfig };
  signal: AbortSignal;
}

function fixture(history: (request: Request) => unknown = () => response(page())) {
  // Only the remote API boundary is replaced; the drawer, history and draft editor are real.
  const request = vi.fn(async (input) => {
    if (input.url === 'tenants:readAccessConfig')
      return response({ identity: { ...identity, collectionName: input.data.collectionName }, config });
    if (input.url === 'tenants:validateAccessConfig') return response({ identity, config: input.data.config });
    if (input.url === 'tenants:previewAccessConfigRevision') return response(preview());
    return history(input);
  });
  const api = { auth: { role: 'manager' }, request };
  const view = (name = 'documents') => (
    <APIClientProvider apiClient={api as never}>
      <TenantAccessConfigView collection={{ name }} onClose={() => {}} />
    </APIClientProvider>
  );
  return { request, api, view };
}

describe('access rule history in the management drawer', () => {
  it('loads lazily, restores into the current editing base, and validates without saving', async () => {
    const { request, view } = fixture(() => response(page(3)));
    const { findByRole, getByRole, findByText, queryByRole } = render(view());
    await findByRole('button', { name: 'View rule history' });
    expect(request).toHaveBeenCalledOnce();
    fireEvent.click(getByRole('button', { name: 'View rule history' }));
    await findByRole('button', { name: 'Create draft from revision 3' });
    expect(request.mock.calls[1][0]).toMatchObject({
      url: 'tenants:listAccessConfigRevisions',
      method: 'post',
      headers: { 'X-Data-Source': 'main' },
      data: { dataSourceKey: 'main', collectionName: 'documents', limit: 20 },
    });
    expect(queryByRole('button', { name: 'Edit rule draft' })).not.toBeInTheDocument();
    fireEvent.click(getByRole('button', { name: 'Create draft from revision 3' }));
    await findByText('Draft from revision 3, based on current revision 7. Changes have not been saved or enabled.');
    expect(getByRole('textbox', { name: 'Rule name' })).toHaveValue('Historical rule');
    fireEvent.click(getByRole('button', { name: 'Validate draft' }));
    await findByText('Draft validation passed. Changes have not been saved or enabled.');
    expect(request.mock.calls[2][0]).toMatchObject({
      url: 'tenants:previewAccessConfigRevision',
      data: { dataSourceKey: 'main', collectionName: 'documents', revision: 3 },
    });
    expect(request.mock.calls[3][0].data.config.revision).toBe(7);
    expect(queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    fireEvent.click(getByRole('button', { name: 'Discard draft' }));
    expect(queryByRole('textbox', { name: 'Rule name' })).not.toBeInTheDocument();
  });

  it('replaces bounded pages and returns to the newest page', async () => {
    const { request, view } = fixture(({ data }) => response(data.beforeRevision ? page(3) : page(7, 7)));
    const { findByRole, getByRole, queryByRole } = render(view());
    fireEvent.click(await findByRole('button', { name: 'View rule history' }));
    await findByRole('button', { name: 'Create draft from revision 7' });
    fireEvent.click(getByRole('button', { name: 'Older revisions' }));
    await findByRole('button', { name: 'Create draft from revision 3' });
    expect(queryByRole('button', { name: 'Create draft from revision 7' })).not.toBeInTheDocument();
    expect(getByRole('button', { name: 'Older revisions' })).toBeDisabled();
    expect(request.mock.calls[2][0].data.beforeRevision).toBe(7);
    fireEvent.click(getByRole('button', { name: 'Newest revisions' }));
    await findByRole('button', { name: 'Create draft from revision 7' });
    expect(request.mock.calls[3][0].data).not.toHaveProperty('beforeRevision');
  });

  it('shows a safe load failure and retries without displaying another collection history', async () => {
    let calls = 0;
    const { view } = fixture(() => {
      if (++calls === 1) return response({ ...page(3), identity: { ...identity, collectionName: 'other' } });
      return response(page(3));
    });
    const { findByRole, getByRole, findByText, queryByRole } = render(view());
    fireEvent.click(await findByRole('button', { name: 'View rule history' }));
    await findByText('Unable to load rule history. Try again.');
    expect(queryByRole('button', { name: 'Create draft from revision 3' })).not.toBeInTheDocument();
    fireEvent.click(getByRole('button', { name: 'Newest revisions' }));
    await findByRole('button', { name: 'Create draft from revision 3' });
  });

  it('keeps a rejected historical draft unavailable while allowing another attempt', async () => {
    const { request, view } = fixture(() => response(page(3)));
    const original = request.getMockImplementation()!;
    let attempts = 0;
    request.mockImplementation(async (input) => {
      if (input.url === 'tenants:previewAccessConfigRevision' && ++attempts === 1)
        throw { response: { status: 400, data: { errors: [{ message: 'The historical field was removed.' }] } } };
      return original(input);
    });
    const { findByRole, getByRole, findByText, queryByRole } = render(view());
    fireEvent.click(await findByRole('button', { name: 'View rule history' }));
    fireEvent.click(await findByRole('button', { name: 'Create draft from revision 3' }));
    await findByText('The historical field was removed.');
    expect(queryByRole('textbox', { name: 'Rule name' })).not.toBeInTheDocument();
    fireEvent.click(getByRole('button', { name: 'Create draft from revision 3' }));
    await findByRole('textbox', { name: 'Rule name' });
  });

  it.each(['identity', 'source', 'base'] as const)('rejects a mismatched %s before opening an editor', async (kind) => {
    const { request, view } = fixture(() => response(page(3)));
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (input) => {
      if (input.url !== 'tenants:previewAccessConfigRevision') return original(input);
      const data = preview();
      if (kind === 'identity') data.identity = { ...identity, collectionKey: 'replacement' };
      if (kind === 'source') data.sourceRevision = 4;
      if (kind === 'base') data.config = { ...restored, revision: 8 };
      return response(data);
    });
    const { findByRole, getByRole, findByText, queryByRole } = render(view());
    fireEvent.click(await findByRole('button', { name: 'View rule history' }));
    fireEvent.click(await findByRole('button', { name: 'Create draft from revision 3' }));
    await findByText('Unable to prepare this revision. Refresh saved rules and try again.');
    expect(queryByRole('textbox', { name: 'Rule name' })).not.toBeInTheDocument();
    expect(getByRole('button', { name: 'Create draft from revision 3' })).toBeEnabled();
  });

  it('aborts and ignores an older history response after closing and reopening', async () => {
    let resolve!: (value: unknown) => void;
    let calls = 0;
    const { request, view } = fixture(() =>
      ++calls === 1
        ? new Promise((done) => {
            resolve = done;
          })
        : response(page(7)),
    );
    const { findByRole, getByRole, queryByRole } = render(view());
    fireEvent.click(await findByRole('button', { name: 'View rule history' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    const signal = request.mock.calls[1][0].signal as AbortSignal;
    fireEvent.click(getByRole('button', { name: 'Close rule history' }));
    expect(signal.aborted).toBe(true);
    fireEvent.click(getByRole('button', { name: 'View rule history' }));
    await findByRole('button', { name: 'Create draft from revision 7' });
    await act(async () => resolve(response(page(3))));
    expect(queryByRole('button', { name: 'Create draft from revision 3' })).not.toBeInTheDocument();
  });

  it.each(['role', 'table', 'refresh'] as const)('discards pending preview on %s changes', async (change) => {
    const { request, api, view } = fixture(() => response(page(3)));
    const original = request.getMockImplementation()!;
    let resolve!: (value: unknown) => void;
    request.mockImplementation(async (input) =>
      input.url === 'tenants:previewAccessConfigRevision'
        ? new Promise((done) => {
            resolve = done;
          })
        : original(input),
    );
    const { findByRole, getByRole, rerender, queryByRole } = render(view());
    fireEvent.click(await findByRole('button', { name: 'View rule history' }));
    fireEvent.click(await findByRole('button', { name: 'Create draft from revision 3' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    const signal = request.mock.calls[2][0].signal as AbortSignal;
    if (change === 'role') {
      api.auth.role = 'viewer';
      rerender(view());
    }
    if (change === 'table') rerender(view('other'));
    if (change === 'refresh') fireEvent.click(getByRole('button', { name: 'Refresh saved rules' }));
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(response(preview())));
    expect(queryByRole('textbox', { name: 'Rule name' })).not.toBeInTheDocument();
    await findByRole('button', { name: 'View rule history' });
  });
});

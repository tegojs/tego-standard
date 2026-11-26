import { vi } from 'vitest';

import { createAccessConfigSave } from '../../actions/save-access-config';

const { inspectAccessConfig } = vi.hoisted(() => ({ inspectAccessConfig: vi.fn() }));

vi.mock('../../access-control/config-inspection', () => ({ inspectAccessConfig }));

const identity = { dataSourceKey: 'main', collectionName: 'documents', collectionKey: 'documents-key' };
const submitted = { schemaVersion: 1, revision: 4, ownership: { enabled: true }, rules: [] };
const saved = { ...submitted, revision: 5 };
const newer = { ...submitted, revision: 6 };

describe('access configuration save response', () => {
  it('reports this committed revision as saved when another writer commits before the response read', async () => {
    const store = { save: vi.fn().mockResolvedValue(saved) };
    inspectAccessConfig
      .mockResolvedValueOnce({ identity, config: submitted, validatedConfig: submitted, store })
      .mockResolvedValueOnce({ identity, config: newer });

    const ctx: any = {
      state: { currentUser: { id: 42 } },
      method: 'POST',
      action: { params: { values: { ...identity, config: submitted } } },
      throw(status: number, message: string, details?: object) {
        throw Object.assign(new Error(message), { status, ...details });
      },
    };
    const next = vi.fn();

    await createAccessConfigSave({} as never)(ctx, next);

    expect(store.save).toHaveBeenCalledWith(identity, submitted, { userId: 42 });
    expect(ctx.body).toEqual({ identity, config: saved });
    expect(inspectAccessConfig).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
  });
});

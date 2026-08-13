import { Model } from '@tego/server';

import { redactSensitiveAuthenticationData, serializeAuthenticatedUser } from '../sensitive-data';

describe('redactSensitiveAuthenticationData', () => {
  it('recursively removes authentication secrets without mutating the source', () => {
    const createdAt = new Date('2026-08-13T00:00:00.000Z');
    const source: any = {
      id: 1,
      password: 'root-secret',
      createdAt,
      users: [{ id: 2, resetToken: 'nested-secret' }],
    };
    source.self = source;

    const result: any = redactSensitiveAuthenticationData(source);

    expect(result).not.toBe(source);
    expect(result).toMatchObject({ id: 1, users: [{ id: 2 }] });
    expect(result.password).toBeUndefined();
    expect(result.users[0].resetToken).toBeUndefined();
    expect(result.createdAt).toEqual(createdAt);
    expect(result.createdAt).not.toBe(createdAt);
    expect(result.self).toBe(result);
    expect(source.password).toBe('root-secret');
    expect(source.users[0].resetToken).toBe('nested-secret');
  });

  it('exposes password presence as a boolean without exposing the password', () => {
    expect(serializeAuthenticatedUser({ id: 1, password: 'secret' })).toEqual({ id: 1, hasPassword: true });
    expect(serializeAuthenticatedUser({ id: 2, password: null })).toEqual({ id: 2, hasPassword: false });
    expect(serializeAuthenticatedUser({ id: 3, hasPassword: true })).toEqual({ id: 3, hasPassword: true });
  });

  it('does not execute custom serializers while redacting plain objects', () => {
    const toJSON = vi.fn(() => ({ password: 'serializer-secret' }));
    const source: any = {
      id: 1,
      password: 'secret',
      toJSON,
    };
    source.self = source;

    const result: any = redactSensitiveAuthenticationData(source);

    expect(toJSON).not.toHaveBeenCalled();
    expect(result.id).toBe(1);
    expect(result.password).toBeUndefined();
    expect(result.toJSON).toBeUndefined();
    expect(result.self).toBe(result);
  });

  it('removes sensitive entries from persisted key-value summaries', () => {
    const result = redactSensitiveAuthenticationData([
      { key: 'nickname', value: 'Reviewer' },
      { key: 'password', value: 'password-hash' },
      { key: 'createdBy.resetToken', value: 'reset-token' },
    ]);

    expect(result).toEqual([{ key: 'nickname', value: 'Reviewer' }]);
  });

  it('prefers plain model data when model serialization fails', () => {
    const get = vi.fn().mockReturnValue({ id: 1, password: 'model-password' });
    const toJSON = vi.fn(() => {
      throw new TypeError('stale association');
    });
    const model = Object.create(Model.prototype);
    model.dataValues = { id: 1, password: 'model-password' };
    model.get = get;
    model.toJSON = toJSON;

    expect(redactSensitiveAuthenticationData(model)).toEqual({ id: 1 });
    expect(get).toHaveBeenCalledWith({ plain: true });
    expect(toJSON).not.toHaveBeenCalled();
  });
});

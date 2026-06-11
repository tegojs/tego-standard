import { AuthErrorCode } from '@tego/server';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  issuedTokensCollectionName,
  RENEWED_JTI_CACHE_MS,
  tokenPolicyCollectionName,
  tokenPolicyRecordKey,
} from '../../constants';
import { TokenController } from '../token-controller';

describe('TokenController', () => {
  let cache: any;
  let logger: any;
  let issuedTokenRepo: any;
  let tokenPolicyRepo: any;
  let issuedTokenModel: any;
  let app: any;
  let tokenController: TokenController;

  beforeEach(() => {
    cache = {
      get: vi.fn(),
      set: vi.fn(),
      wrap: vi.fn((key, getter) => getter()),
    };
    logger = {
      error: vi.fn(),
      info: vi.fn(),
    };
    issuedTokenRepo = {
      updateOrCreate: vi.fn(),
      find: vi.fn().mockResolvedValue([]),
      destroy: vi.fn(),
    };
    tokenPolicyRepo = {
      findOne: vi.fn(),
    };
    issuedTokenModel = {
      update: vi.fn(),
    };
    app = {
      db: {
        getRepository: vi.fn((name) => {
          if (name === issuedTokensCollectionName) return issuedTokenRepo;
          if (name === tokenPolicyCollectionName) return tokenPolicyRepo;
          throw new Error(`Unexpected repository: ${name}`);
        }),
        getModel: vi.fn((name) => {
          if (name === issuedTokensCollectionName) return issuedTokenModel;
          throw new Error(`Unexpected model: ${name}`);
        }),
      },
    };
    tokenController = new TokenController({ cache, app, logger });
  });

  it('adds token info and removes expired sessions for sqlite', async () => {
    tokenPolicyRepo.findOne.mockResolvedValue({
      config: {
        tokenExpirationTime: '1h',
        sessionExpirationTime: '1d',
        expiredTokenRenewLimit: '10m',
      },
    });
    issuedTokenRepo.find.mockResolvedValue([{ get: () => 'expired-token-id' }]);

    const result = await tokenController.add({ userId: 1 });

    expect(result).toMatchObject({
      renewed: false,
      userId: 1,
    });
    expect(result.jti).toBeTruthy();
    expect(result.issuedTime).toEqual(expect.any(Number));
    expect(result.signInTime).toEqual(expect.any(Number));
    expect(issuedTokenRepo.updateOrCreate).toHaveBeenCalledWith({
      filterKeys: ['userId'],
      values: result,
    });
    expect(issuedTokenRepo.destroy).toHaveBeenCalledWith({
      filterByTk: ['expired-token-id'],
    });
  });

  it('skips expired session cleanup when token policy is missing', async () => {
    tokenPolicyRepo.findOne.mockResolvedValue(null);

    await tokenController.removeSessionExpiredTokens(1);

    expect(issuedTokenRepo.find).not.toHaveBeenCalled();
    expect(issuedTokenRepo.destroy).not.toHaveBeenCalled();
  });

  it('does not destroy when there are no expired sessions', async () => {
    tokenPolicyRepo.findOne.mockResolvedValue({
      config: {
        tokenExpirationTime: '1h',
        sessionExpirationTime: '1d',
        expiredTokenRenewLimit: '10m',
      },
    });
    issuedTokenRepo.find.mockResolvedValue([]);

    await tokenController.removeSessionExpiredTokens(1);

    expect(issuedTokenRepo.find).toHaveBeenCalledWith({
      filter: {
        userId: 1,
        signInTime: {
          $lt: expect.any(Number),
        },
      },
    });
    expect(issuedTokenRepo.destroy).not.toHaveBeenCalled();
  });

  it('converts token policy config to milliseconds through cache.wrap', async () => {
    tokenPolicyRepo.findOne.mockResolvedValue({
      config: {
        tokenExpirationTime: '1h',
        sessionExpirationTime: '2d',
        expiredTokenRenewLimit: '15m',
      },
    });

    await expect(tokenController.getConfig()).resolves.toEqual({
      tokenExpirationTime: 60 * 60 * 1000,
      sessionExpirationTime: 2 * 24 * 60 * 60 * 1000,
      expiredTokenRenewLimit: 15 * 60 * 1000,
    });
    expect(cache.wrap).toHaveBeenCalledWith('config', expect.any(Function));
    expect(tokenPolicyRepo.findOne).toHaveBeenCalledWith({
      filterByTk: tokenPolicyRecordKey,
    });
  });

  it('stores token policy config in milliseconds', async () => {
    await tokenController.setConfig({
      tokenExpirationTime: '30m',
      sessionExpirationTime: '7d',
      expiredTokenRenewLimit: '5m',
    });

    expect(cache.set).toHaveBeenCalledWith('config', {
      tokenExpirationTime: 30 * 60 * 1000,
      sessionExpirationTime: 7 * 24 * 60 * 60 * 1000,
      expiredTokenRenewLimit: 5 * 60 * 1000,
    });
  });

  it('renews an existing jti and caches the renewed mapping', async () => {
    issuedTokenModel.update.mockResolvedValue([1]);

    const result = await tokenController.renew('old-jti');

    expect(result.jti).toBeTruthy();
    expect(result.jti).not.toBe('old-jti');
    expect(result.issuedTime).toEqual(expect.any(Number));
    expect(issuedTokenModel.update).toHaveBeenCalledWith(
      {
        jti: result.jti,
        issuedTime: result.issuedTime,
      },
      {
        where: { jti: 'old-jti' },
      },
    );
    expect(cache.set).toHaveBeenCalledWith('jti-renewed-cache:old-jti', result, RENEWED_JTI_CACHE_MS);
    expect(cache.set).toHaveBeenCalledWith('jti-renewed-cahce:old-jti', result, RENEWED_JTI_CACHE_MS);
    expect(logger.info).toHaveBeenCalledWith('jti renewed', {
      oldJti: 'old-jti',
      newJti: result.jti,
      issuedTime: result.issuedTime,
    });
  });

  it('returns cached renewed jti when concurrent renew already succeeded', async () => {
    const cached = { jti: 'new-jti', issuedTime: 123 };
    issuedTokenModel.update.mockResolvedValue([0]);
    cache.get.mockResolvedValue(cached);

    await expect(tokenController.renew('old-jti')).resolves.toEqual(cached);
    expect(cache.get).toHaveBeenCalledWith('jti-renewed-cache:old-jti');
  });

  it('migrates cached renewed jti from legacy key', async () => {
    const cached = { jti: 'new-jti', issuedTime: 123 };
    issuedTokenModel.update.mockResolvedValue([0]);
    cache.get.mockResolvedValueOnce(null).mockResolvedValueOnce(cached);

    await expect(tokenController.renew('old-jti')).resolves.toEqual(cached);
    expect(cache.get).toHaveBeenCalledWith('jti-renewed-cache:old-jti');
    expect(cache.get).toHaveBeenCalledWith('jti-renewed-cahce:old-jti');
    expect(cache.set).toHaveBeenCalledWith('jti-renewed-cache:old-jti', cached, RENEWED_JTI_CACHE_MS);
  });

  it('throws auth error when jti cannot be renewed', async () => {
    issuedTokenModel.update.mockResolvedValue([0]);
    cache.get.mockResolvedValue(null);

    await expect(tokenController.renew('missing-jti')).rejects.toMatchObject({
      code: AuthErrorCode.TOKEN_RENEW_FAILED,
      message: 'Your session has expired. Please sign in again.',
    });
    expect(logger.error).toHaveBeenCalledWith('jti renew failed', {
      module: 'auth',
      submodule: 'token-controller',
      method: 'renew',
      jti: 'missing-jti',
      code: AuthErrorCode.TOKEN_RENEW_FAILED,
    });
  });
});

import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  issuedTokensCollectionName,
  RENEWED_JTI_CACHE_MS,
  tokenPolicyCollectionName,
  tokenPolicyRecordKey,
} from '../../constants';
import { TokenController } from '../token-controller';

vi.mock('node:crypto', () => ({
  randomUUID: vi.fn(),
}));

describe('TokenController', () => {
  let tokenController: TokenController;
  let cache: any;
  let app: any;
  let logger: any;
  let issuedTokenRepo: any;
  let tokenPolicyRepo: any;
  let issuedTokenModel: any;

  beforeEach(() => {
    vi.clearAllMocks();

    cache = {
      get: vi.fn(),
      set: vi.fn(),
      wrap: vi.fn((key, callback) => callback()),
    };
    logger = {
      error: vi.fn(),
      info: vi.fn(),
    };
    issuedTokenRepo = {
      updateOrCreate: vi.fn(),
      find: vi.fn(),
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
          if (name === issuedTokensCollectionName) {
            return issuedTokenRepo;
          }
          if (name === tokenPolicyCollectionName) {
            return tokenPolicyRepo;
          }
          return null;
        }),
        getModel: vi.fn(() => issuedTokenModel),
      },
    };

    tokenController = new TokenController({ cache, app, logger });
  });

  describe('getConfig', () => {
    it('returns numeric token policy config from cache', async () => {
      tokenPolicyRepo.findOne.mockResolvedValue({
        config: {
          tokenExpirationTime: '1h',
          sessionExpirationTime: '7d',
          expiredTokenRenewLimit: '10m',
        },
      });

      await expect(tokenController.getConfig()).resolves.toEqual({
        tokenExpirationTime: 60 * 60 * 1000,
        sessionExpirationTime: 7 * 24 * 60 * 60 * 1000,
        expiredTokenRenewLimit: 10 * 60 * 1000,
      });
      expect(cache.wrap).toHaveBeenCalledWith('config', expect.any(Function));
      expect(tokenPolicyRepo.findOne).toHaveBeenCalledWith({ filterByTk: tokenPolicyRecordKey });
    });

    it('returns null when no token policy exists', async () => {
      tokenPolicyRepo.findOne.mockResolvedValue(null);

      await expect(tokenController.getConfig()).resolves.toBeNull();
    });
  });

  describe('setConfig', () => {
    it('stores numeric token policy config in cache', async () => {
      await tokenController.setConfig({
        tokenExpirationTime: '2h',
        sessionExpirationTime: '3d',
        expiredTokenRenewLimit: '5m',
      });

      expect(cache.set).toHaveBeenCalledWith('config', {
        tokenExpirationTime: 2 * 60 * 60 * 1000,
        sessionExpirationTime: 3 * 24 * 60 * 60 * 1000,
        expiredTokenRenewLimit: 5 * 60 * 1000,
      });
    });
  });

  describe('add', () => {
    it('creates issued token info and removes expired sqlite session tokens synchronously', async () => {
      vi.mocked(randomUUID).mockReturnValue('jti-1');
      vi.spyOn(Date, 'now').mockReturnValue(1000);
      vi.stubEnv('DB_DIALECT', 'sqlite');
      cache.wrap.mockResolvedValue({
        tokenExpirationTime: 100,
        sessionExpirationTime: 300,
        expiredTokenRenewLimit: 50,
      });
      issuedTokenRepo.find.mockResolvedValue([{ get: vi.fn(() => 11) }, { get: vi.fn(() => 12) }]);

      await expect(tokenController.add({ userId: 7 })).resolves.toEqual({
        jti: 'jti-1',
        issuedTime: 1000,
        signInTime: 1000,
        renewed: false,
        userId: 7,
      });

      expect(issuedTokenRepo.updateOrCreate).toHaveBeenCalledWith({
        filterKeys: ['userId'],
        values: {
          jti: 'jti-1',
          issuedTime: 1000,
          signInTime: 1000,
          renewed: false,
          userId: 7,
        },
      });
      expect(issuedTokenRepo.find).toHaveBeenCalledWith({
        filter: {
          userId: 7,
          signInTime: { $lt: 700 },
        },
      });
      expect(issuedTokenRepo.destroy).toHaveBeenCalledWith({ filterByTk: [11, 12] });
    });

    it('does not destroy expired tokens when none are found', async () => {
      vi.mocked(randomUUID).mockReturnValue('jti-2');
      vi.spyOn(Date, 'now').mockReturnValue(2000);
      vi.stubEnv('DB_DIALECT', 'sqlite');
      cache.wrap.mockResolvedValue({
        tokenExpirationTime: 100,
        sessionExpirationTime: 300,
        expiredTokenRenewLimit: 50,
      });
      issuedTokenRepo.find.mockResolvedValue([]);

      await tokenController.add({ userId: 8 });

      expect(issuedTokenRepo.destroy).not.toHaveBeenCalled();
    });

    it('logs expired-token cleanup errors without failing token creation', async () => {
      vi.mocked(randomUUID).mockReturnValue('jti-3');
      vi.stubEnv('DB_DIALECT', 'sqlite');
      cache.wrap.mockRejectedValue(new Error('config failed'));

      await expect(tokenController.add({ userId: 9 })).resolves.toMatchObject({ jti: 'jti-3', userId: 9 });
      expect(logger.error).toHaveBeenCalledWith(expect.any(Error), {
        module: 'auth',
        submodule: 'token-controller',
        method: 'removeSessionExpiredTokens',
      });
    });
  });

  describe('renew', () => {
    it('updates the jti and caches renewed token data', async () => {
      vi.mocked(randomUUID).mockReturnValue('new-jti');
      vi.spyOn(Date, 'now').mockReturnValue(3000);
      issuedTokenModel.update.mockResolvedValue([1]);

      await expect(tokenController.renew('old-jti')).resolves.toEqual({ jti: 'new-jti', issuedTime: 3000 });

      expect(issuedTokenModel.update).toHaveBeenCalledWith(
        { jti: 'new-jti', issuedTime: 3000 },
        { where: { jti: 'old-jti' } },
      );
      expect(cache.set).toHaveBeenCalledWith(
        'jti-renewed-cahce:old-jti',
        { jti: 'new-jti', issuedTime: 3000 },
        RENEWED_JTI_CACHE_MS,
      );
      expect(logger.info).toHaveBeenCalledWith('jti renewed', {
        oldJti: 'old-jti',
        newJti: 'new-jti',
        issuedTime: 3000,
      });
    });

    it('returns cached renewed jti when a concurrent renew already succeeded', async () => {
      issuedTokenModel.update.mockResolvedValue([0]);
      cache.get.mockResolvedValue({ jti: 'cached-jti', issuedTime: 4000 });

      await expect(tokenController.renew('old-jti')).resolves.toEqual({ jti: 'cached-jti', issuedTime: 4000 });
    });

    it('throws auth error when jti cannot be renewed', async () => {
      issuedTokenModel.update.mockResolvedValue([0]);
      cache.get.mockResolvedValue(null);

      await expect(tokenController.renew('missing-jti')).rejects.toMatchObject({ code: 'TOKEN_RENEW_FAILED' });
      expect(logger.error).toHaveBeenCalledWith('jti renew failed', {
        module: 'auth',
        submodule: 'token-controller',
        method: 'renew',
        jti: 'missing-jti',
        code: 'TOKEN_RENEW_FAILED',
      });
    });
  });
});

import { randomUUID } from 'node:crypto';
import {
  Application,
  AuthError,
  AuthErrorCode,
  Cache,
  Database,
  ITokenControlService,
  NumericTokenPolicyConfig,
  Repository,
  TokenInfo,
  TokenPolicyConfig,
  type SystemLogger,
} from '@tego/server';

import ms from 'ms';

import {
  issuedTokensCollectionName,
  RENEWED_JTI_CACHE_MS,
  tokenPolicyCollectionName,
  tokenPolicyRecordKey,
} from '../constants';

type TokenControlService = ITokenControlService;

const JTICACHEKEY = 'token-jti';
const RENEWED_JTI_CACHE_KEY_PREFIX = 'jti-renewed-cache';
// Keep the historical "cahce" key during the dual-write migration. Remove it after renewed JTI entries have aged out.
const LEGACY_RENEWED_JTI_CACHE_KEY_PREFIX = 'jti-renewed-cahce';

function getRenewedJtiCacheKey(jti: string) {
  return `${RENEWED_JTI_CACHE_KEY_PREFIX}:${jti}`;
}

function getLegacyRenewedJtiCacheKey(jti: string) {
  return `${LEGACY_RENEWED_JTI_CACHE_KEY_PREFIX}:${jti}`;
}

export class TokenController implements TokenControlService {
  cache: Cache;
  app: Application;
  db: Database;
  logger: SystemLogger;

  constructor({ cache, app, logger }: { cache: Cache; app: Application; logger: SystemLogger }) {
    this.cache = cache;
    this.app = app;
    this.logger = logger;
  }

  async setTokenInfo(id: string, value: TokenInfo): Promise<void> {
    const repo = this.app.db.getRepository<Repository<TokenInfo>>(issuedTokensCollectionName);
    await repo.updateOrCreate({ filterKeys: ['userId'], values: value });
    return;
  }

  getConfig() {
    return this.cache.wrap<NumericTokenPolicyConfig>('config', async () => {
      const repo = this.app.db.getRepository(tokenPolicyCollectionName);
      const configRecord = await repo.findOne({ filterByTk: tokenPolicyRecordKey });
      if (!configRecord) return null;
      const config = configRecord.config as TokenPolicyConfig;
      return {
        tokenExpirationTime: ms(config.tokenExpirationTime),
        sessionExpirationTime: ms(config.sessionExpirationTime),
        expiredTokenRenewLimit: ms(config.expiredTokenRenewLimit),
      };
    });
  }
  setConfig(config: TokenPolicyConfig) {
    return this.cache.set('config', {
      tokenExpirationTime: ms(config.tokenExpirationTime),
      sessionExpirationTime: ms(config.sessionExpirationTime),
      expiredTokenRenewLimit: ms(config.expiredTokenRenewLimit),
    });
  }

  async removeSessionExpiredTokens(userId: number) {
    const config = await this.getConfig();
    if (!config) {
      return;
    }
    const issuedTokenRepo = this.app.db.getRepository(issuedTokensCollectionName);
    const currTS = Date.now();
    const filter = {
      userId: userId,
      signInTime: {
        $lt: currTS - config.sessionExpirationTime,
      },
    };
    // 先查询是否有需要删除的记录，避免空数组导致的 IN (NULL) SQL 问题
    const expiredTokens = await issuedTokenRepo.find({ filter });
    if (expiredTokens.length === 0) {
      return;
    }
    return issuedTokenRepo.destroy({
      filterByTk: expiredTokens.map((token) => token.get('id')),
    });
  }

  async add({ userId }: { userId: number }) {
    const jti = randomUUID();
    const currTS = Date.now();
    const data = {
      jti,
      issuedTime: currTS,
      signInTime: currTS,
      renewed: false,
      userId,
    };
    await this.setTokenInfo(jti, data);

    const logCleanupError = (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(message, {
        module: 'auth',
        submodule: 'token-controller',
        method: 'removeSessionExpiredTokens',
        err,
      });
    };

    if (process.env.DB_DIALECT === 'sqlite') {
      // SQLITE does not support concurrent operations
      try {
        await this.removeSessionExpiredTokens(userId);
      } catch (err) {
        logCleanupError(err);
      }
    } else {
      void this.removeSessionExpiredTokens(userId).catch(logCleanupError);
    }

    return data;
  }

  private async setLegacyRenewedJtiCache(jti: string, data: { jti: string; issuedTime: EpochTimeStamp }) {
    try {
      await this.cache.set(getLegacyRenewedJtiCacheKey(jti), data, RENEWED_JTI_CACHE_MS);
    } catch (err) {
      this.logger.warn('legacy renewed jti cache write failed', {
        module: 'auth',
        submodule: 'token-controller',
        method: 'renew',
        jti,
        err,
      });
    }
  }

  renew: TokenControlService['renew'] = async (jti) => {
    const repo = this.app.db.getRepository(issuedTokensCollectionName);
    const model = this.app.db.getModel(issuedTokensCollectionName);

    const newId = randomUUID();
    const issuedTime = Date.now();

    const [count] = await model.update(
      { jti: newId, issuedTime },

      { where: { jti } },
    );

    if (count === 1) {
      const renewedJtiData = { jti: newId, issuedTime };
      await this.cache.set(getRenewedJtiCacheKey(jti), renewedJtiData, RENEWED_JTI_CACHE_MS);
      await this.setLegacyRenewedJtiCache(jti, renewedJtiData);
      this.logger.info('jti renewed', { oldJti: jti, newJti: newId, issuedTime });
      return renewedJtiData;
    } else {
      const cachedJtiData = await this.cache.get(getRenewedJtiCacheKey(jti));
      if (cachedJtiData) {
        return cachedJtiData as { jti: string; issuedTime: EpochTimeStamp };
      }

      const legacyCachedJtiData = await this.cache.get(getLegacyRenewedJtiCacheKey(jti));
      if (legacyCachedJtiData) {
        await this.cache.set(getRenewedJtiCacheKey(jti), legacyCachedJtiData, RENEWED_JTI_CACHE_MS);
        return legacyCachedJtiData as { jti: string; issuedTime: EpochTimeStamp };
      }

      this.logger.error('jti renew failed', {
        module: 'auth',
        submodule: 'token-controller',
        method: 'renew',
        jti,
        code: AuthErrorCode.TOKEN_RENEW_FAILED,
      });

      throw new AuthError({
        message: 'Your session has expired. Please sign in again.',
        code: AuthErrorCode.TOKEN_RENEW_FAILED,
      });
    }
  };
}

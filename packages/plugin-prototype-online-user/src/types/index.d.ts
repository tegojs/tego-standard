import { RedisClient } from 'redis';

import { WorkerManager } from '../server/workerManager';

declare module '@tego/server' {
  interface Application {
    online?: {
      all: RedisClient;
      pub: RedisClient;
      sub: RedisClient;
    };
  }
}

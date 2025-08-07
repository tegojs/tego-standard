import { WorkerManager } from '../server/workerManager';

declare module '@tego/server' {
  interface Application {
    worker: WorkerManager;
  }
}

import './packages/client/src/preload';

// Override asyncUtilTimeout from @tachybase/test/setup/client.ts (30s → 5s).
// 30s causes failing waitFor assertions to block for 30s each, making the suite appear stuck.
import { configure } from '@tachybase/test/client';
configure({ asyncUtilTimeout: 5000 });

class ResizeObserverMock {
  observe() {}

  unobserve() {}

  disconnect() {}
}

globalThis.ResizeObserver ??= ResizeObserverMock as any;

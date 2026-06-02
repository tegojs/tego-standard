import './packages/client/src/preload';

import { configure } from '@testing-library/react';

// @tachybase/test sets asyncUtilTimeout to 30s, causing failing waitFor assertions to retry
// for 30s each. With many failing tests this makes the suite appear to hang. Override to 5s.
configure({ asyncUtilTimeout: 5000 });

class ResizeObserverMock {
  observe() {}

  unobserve() {}

  disconnect() {}
}

globalThis.ResizeObserver ??= ResizeObserverMock as any;

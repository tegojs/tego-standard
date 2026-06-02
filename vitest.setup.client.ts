import './packages/client/src/preload';

class ResizeObserverMock {
  observe() {}

  unobserve() {}

  disconnect() {}
}

globalThis.ResizeObserver ??= ResizeObserverMock as any;

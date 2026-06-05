import './packages/client/src/preload';

// Intercept CSS/Less requires from compiled packages
// that use CJS require('./style.css') which fails in Node.js.
require.extensions['.css'] = (m: any) => {
  m.exports = {};
};
require.extensions['.less'] = (m: any) => {
  m.exports = {};
};

class ResizeObserverMock {
  observe() {}

  unobserve() {}

  disconnect() {}
}

globalThis.ResizeObserver ??= ResizeObserverMock as any;

if (!globalThis.requestAnimationFrame) {
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(cb, 0) as unknown as number;
  globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id);
}

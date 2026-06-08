const nodeWebAPIs = {
  fetch: globalThis.fetch,
  Headers: globalThis.Headers,
  Request: globalThis.Request,
  Response: globalThis.Response,
  AbortController: globalThis.AbortController,
  AbortSignal: globalThis.AbortSignal,
};

await import('./packages/client/src/preload');

class ResizeObserverMock {
  observe() {}

  unobserve() {}

  disconnect() {}
}

globalThis.ResizeObserver ??= ResizeObserverMock as any;

Object.assign(globalThis, nodeWebAPIs);

const NativeRequest = globalThis.Request;
globalThis.Request = class RequestWithCompatibleSignal extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    try {
      super(input, init);
    } catch (error) {
      if (init?.signal && error instanceof TypeError && /AbortSignal/.test(error.message)) {
        const { signal, ...compatibleInit } = init;
        super(input, compatibleInit);
        return;
      }
      throw error;
    }
  }
} as typeof Request;

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem: (key: string) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key: string, value: string) => {
      storage.set(key, String(value));
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => {
      storage.clear();
    },
    key: (index: number) => Array.from(storage.keys())[index] ?? null,
    get length() {
      return storage.size;
    },
  } as Storage,
});

if (!globalThis.requestAnimationFrame) {
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(cb, 0) as unknown as number;
  globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id);
}

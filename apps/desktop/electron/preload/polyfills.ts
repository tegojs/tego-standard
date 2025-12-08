/**
 * TextEncoder/TextDecoder polyfill for Electron
 */
export function setupTextEncoderPolyfill(): void {
  const globalObj = globalThis as any;

  let TextEncoderClass: typeof TextEncoder | null = null;
  let TextDecoderClass: typeof TextDecoder | null = null;

  try {
    const util = require('node:util');
    if (util.TextEncoder && typeof util.TextEncoder === 'function') {
      TextEncoderClass = util.TextEncoder;
      TextDecoderClass = util.TextDecoder;
      console.log('[Preload] TextEncoder/TextDecoder loaded from Node.js util');
    }
  } catch (e) {
    // Node.js util 不可用，继续尝试其他方式
  }

  if (!TextEncoderClass) {
    try {
      if (typeof globalObj.TextEncoder === 'function') {
        TextEncoderClass = globalObj.TextEncoder;
        TextDecoderClass = globalObj.TextDecoder;
        console.log('[Preload] TextEncoder/TextDecoder already available in global scope');
      } else if (typeof window !== 'undefined' && typeof window.TextEncoder === 'function') {
        TextEncoderClass = window.TextEncoder;
        TextDecoderClass = window.TextDecoder;
        console.log('[Preload] TextEncoder/TextDecoder loaded from window');
      }
    } catch (e) {
      // 忽略错误
    }
  }

  if (TextEncoderClass && TextDecoderClass) {
    try {
      const testEncoder = new TextEncoderClass();
      const testDecoder = new TextDecoderClass();
      if (testEncoder && testDecoder) {
        globalObj.TextEncoder = TextEncoderClass;
        globalObj.TextDecoder = TextDecoderClass;

        if (typeof window !== 'undefined') {
          (window as any).TextEncoder = TextEncoderClass;
          (window as any).TextDecoder = TextDecoderClass;
        }

        console.log('[Preload] TextEncoder/TextDecoder polyfill installed and verified');
      }
    } catch (e) {
      console.warn('[Preload] TextEncoder/TextDecoder verification failed:', e);
    }
  } else {
    console.warn('[Preload] Could not find TextEncoder/TextDecoder implementation');
  }
}

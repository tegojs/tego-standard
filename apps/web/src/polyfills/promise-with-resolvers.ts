/**
 * Promise.withResolvers polyfill
 *
 * 为不支持 Promise.withResolvers 的环境提供兼容实现
 * Promise.withResolvers 是 ES2024 的新特性
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/withResolvers
 */

// 扩展 PromiseConstructor 接口以支持 withResolvers
interface PromiseWithResolvers<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: any) => void;
}

interface PromiseConstructor {
  withResolvers<T>(): PromiseWithResolvers<T>;
}

if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function <T>(): PromiseWithResolvers<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: any) => void;

    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    return { promise, resolve, reject };
  };
}

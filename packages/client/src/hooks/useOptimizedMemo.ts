import { useRef } from 'react';

import _ from 'lodash';

/**
 * 优化的 useMemo，先进行引用比较，仅在引用不同时才使用 lodash 的 isEqual 进行深度比较
 * 这样可以在大多数情况下（引用相同时）避免深度比较的开销
 *
 * 性能分析：
 * - 引用比较：O(1)，几乎无开销
 * - 深度比较：O(n)，n 为数据大小，使用 lodash.isEqual（比 JSON.stringify 更可靠）
 * - 计算成本：map、compile、字段查找等操作
 *
 * 权衡：对于表单摘要数据（通常 < 10KB），深度比较的开销（< 1ms）
 * 远小于重新计算的成本（map + compile + 字段查找），所以值得缓存
 *
 * 优势：
 * - 使用 lodash.isEqual 替代 JSON.stringify，更可靠（可处理循环引用、特殊类型等）
 * - 代码更简洁，无需手动处理序列化错误
 * - 依赖成熟的库，减少维护成本
 *
 * @example
 * ```tsx
 * const results = useOptimizedMemo(() => {
 *   return expensiveComputation(data);
 * }, [data]);
 * ```
 */
export function useOptimizedMemo<T>(factory: () => T, deps: any[]): T {
  const ref = useRef<{ deps: any[]; value: T }>();

  // 先进行快速引用比较（最快路径）
  if (ref.current && deps.length === ref.current.deps.length && deps.every((dep, i) => dep === ref.current!.deps[i])) {
    return ref.current.value;
  }

  // 引用不同时，进行深度比较
  if (!ref.current || deps.length !== ref.current.deps.length) {
    // 首次渲染或依赖项数量变化，直接重新计算
    const value = factory();
    ref.current = { deps, value };
    return value;
  }

  // 依赖项数量相同，使用 lodash.isEqual 进行深度比较
  const depsChanged = deps.some((dep, i) => {
    const prevDep = ref.current!.deps[i];
    // 先进行引用比较（最快）
    if (dep === prevDep) return false;
    // 使用 lodash.isEqual 进行深度比较
    return !_.isEqual(dep, prevDep);
  });

  if (depsChanged) {
    const value = factory();
    ref.current = { deps, value };
    return value;
  }

  // 深度比较后内容相同，更新依赖项引用
  ref.current.deps = deps;
  return ref.current.value;
}

import { merge } from '@tachybase/schema';

import { useRequest as useReq, useSetState } from 'ahooks';
import { Options, Result } from 'ahooks/es/useRequest/src/types';
import { SetState } from 'ahooks/lib/useSetState';
import { AxiosRequestConfig } from 'axios';
import { cloneDeep } from 'lodash';

import { assign } from './assign';
import { useAPIClient } from './useAPIClient';

type FunctionService = (...args: any[]) => Promise<any>;

export type ReturnTypeOfUseRequest<TData = any> = ReturnType<typeof useRequest<TData>>;

export type ResourceActionOptions<P = any> = {
  resource?: string;
  resourceOf?: any;
  action?: string;
  params?: P;
  url?: string;
  skipNotify?: boolean | ((error: any) => boolean);
  skipAuth?: boolean;
};

export type UseRequestService<P> = AxiosRequestConfig<P> | ResourceActionOptions<P> | FunctionService;

// 原接口，不破坏：仅允许额外可选字段
export type UseRequestOptions = Options<any, any> & {
  uid?: string;
  cacheKey?: string; // 缓存键：与路由(pageKey)组合使用
  pageKey?: string; // 路由作用域（默认 pathname+search）
  usePageCache?: boolean; // 启用缓存（默认 true）
};

export interface UseRequestResult<P> extends Result<P, any> {
  state: any;
  setState: SetState<{}>;
}

const pageCaches: Map<string, Record<string, any>> = new Map();
const getDefaultPageKey = () =>
  typeof window === 'undefined' ? 'ssr' : window.location.pathname + window.location.search;

export function useRequest<P>(service: UseRequestService<P>, options: UseRequestOptions = {}): UseRequestResult<P> {
  const [state, setState] = useSetState({});
  const api = useAPIClient();

  // 前置拦截：仅在 cacheKey 存在时尝试
  const pageKey = options.pageKey || getDefaultPageKey();
  const cacheKey = options.cacheKey;
  const usePageCache = options.usePageCache !== false;

  let cachedData: any;
  if (usePageCache && cacheKey) {
    const pageData = pageCaches.get(pageKey);
    if (pageData && cacheKey in pageData) {
      cachedData = pageData[cacheKey];
    }
  }

  // 构造原始 service
  let baseService: FunctionService;
  if (typeof service === 'function') {
    baseService = service as FunctionService;
  } else if (service) {
    baseService = async (params = {}) => {
      const { resource, url } = service as ResourceActionOptions;
      let args = cloneDeep(service);
      if (resource || url) {
        args.params = args.params || {};
        assign(args.params, params);
      } else {
        args = merge(args, params);
      }
      const response = await api.request(args);
      return response?.data;
    };
  } else {
    baseService = async () => {};
  }

  // 命中缓存则直接返回，不发请求；否则走原逻辑
  const finalService = async (params: any) => {
    if (usePageCache && cacheKey && cachedData !== undefined) {
      return cachedData;
    }
    return baseService(params);
  };

  const tempOptions = {
    ...options,
    // 命中缓存可直接作为初始数据（不影响后续 hooks 行为）
    initialData: cachedData !== undefined ? cachedData : options.initialData,
    onSuccess(...args: any[]) {
      // 保持原逻辑
      // @ts-ignore
      options.onSuccess?.(...args);
      if (options.uid) {
        // @ts-ignore
        api.services[options.uid] = result;
      }
      // 写入缓存（无缓存或强制刷新场景）
      if (usePageCache && cacheKey) {
        const pageData = pageCaches.get(pageKey) || {};
        pageData[cacheKey] = args[0]; // data
        pageCaches.set(pageKey, pageData);
      }
    },
  };

  const result = useReq<P, any>(finalService, tempOptions);
  return { ...result, state, setState };
}

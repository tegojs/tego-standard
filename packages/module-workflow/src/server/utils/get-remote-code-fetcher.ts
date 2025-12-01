import { Application, Container } from '@tego/server';

import { WorkflowRemoteCodeFetcher } from '../services/remote-code-fetcher';

/**
 * 获取 WorkflowRemoteCodeFetcher 服务
 * 优先使用 app.getService，失败时回退到 Container.get
 */
export function getRemoteCodeFetcher(app: Application): WorkflowRemoteCodeFetcher | undefined {
  try {
    return app.getService(WorkflowRemoteCodeFetcher);
  } catch {
    try {
      return Container.get(WorkflowRemoteCodeFetcher);
    } catch {
      return undefined;
    }
  }
}

import { Model } from '@tego/server';

export class EventSourceModel extends Model {
  id: number;
  name: string;
  type: string;
  enabled: boolean;
  code: string;
  workflowKey: string;
  options: {
    resourceName?: string;
    actionName?: string;
    // 针对app,db
    eventName?: string;
    // 针对beforeResource,afterResource
    triggerOnAssociation?: boolean;
    // 是否向工作流透传 httpContext
    useHttpContext?: boolean;
    // 执行失败策略: ignore(默认)/block
    failurePolicy?: 'ignore' | 'block';
    // 单条事件源执行超时时间(ms)，<=0 表示不限制
    timeoutMs?: number;
    // 优先级越小越先执行
    sort?: number;
  };
}

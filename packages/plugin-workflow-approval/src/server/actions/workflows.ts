import { actions } from '@tego/server';

export const workflows = {
  async listApprovalFlows(ctx, next) {
    ctx.action.mergeParams({
      filter: {
        type: 'approval',
        enabled: true,
        // TODO: 仅显示当前用户有权限的流程
      },
    });
    return actions.list(ctx, next);
  },
};

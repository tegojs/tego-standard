import { COLLECTION_WORKFLOWS_NAME } from '@tachybase/module-workflow';
import { actions, Op } from '@tego/server';

import { APPROVAL_STATUS } from '../constants/status';
import { findUniqueObjects } from '../utils';

export const approvalCarbonCopy = {
  async listCentralized(ctx, next) {
    const centralizedApprovalFlow = await ctx.db.getRepository(COLLECTION_WORKFLOWS_NAME).find({
      filter: {
        type: 'approval',
        'config.centralized': true,
      },
      fields: ['id'],
    });
    ctx.action.mergeParams({
      filter: {
        workflowId: centralizedApprovalFlow.map((item) => item.id),
        approval: {
          status: {
            [Op.ne]: APPROVAL_STATUS.DRAFT,
          },
        },
      },
    });

    await actions.list(ctx, next);

    // NOTE: 进一步筛选, 筛选出同个用户下相同的approvalid, 只保留最新的一份.
    if (ctx.body.rows) {
      ctx.body.rows = findUniqueObjects(
        ctx.body.rows,
        ['userId', 'approvalId'],
        'createdAt',
        (a: string, b: string) => new Date(a).getTime() - new Date(b).getTime(),
      );
    }
  },
};

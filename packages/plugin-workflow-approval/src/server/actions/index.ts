import { COLLECTION_NAME_APPROVAL_CARBON_COPY } from '../../common/constants';
import { captureApprovalBusinessWriteGuard } from '../business-write-guard';
import type PluginWorkflowApproval from '../plugin';
import { approvalCarbonCopy } from './approvalCarbonCopy';
import { approvalRecords } from './approvalRecords';
import { approvals } from './approvals';
import { workflows } from './workflows';

function make(name, mod) {
  return Object.keys(mod).reduce(
    (result, key) => ({
      ...result,
      [`${name}:${key}`]: mod[key],
    }),
    {},
  );
}
export function init({ app, options }: PluginWorkflowApproval) {
  const assertBusinessWrite = captureApprovalBusinessWriteGuard(options.businessWriteGuard);
  app.resourcer.registerActions({
    ...make('workflows', workflows),
    ...make('approvals', {
      ...approvals,
      create: (ctx, next) => approvals.create(ctx, next, assertBusinessWrite),
      update: (ctx, next) => approvals.update(ctx, next, assertBusinessWrite),
    }),
    ...make('approvalRecords', approvalRecords),
    ...make(COLLECTION_NAME_APPROVAL_CARBON_COPY, approvalCarbonCopy),
  });
}

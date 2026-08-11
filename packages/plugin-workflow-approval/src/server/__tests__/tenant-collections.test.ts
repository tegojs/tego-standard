import { COLLECTION_NAME_APPROVAL_CARBON_COPY } from '../../common/constants';
import approvalCarbonCopy from '../collections/approvalCarbonCopy';
import approvalExecutions from '../collections/approvalExecutions';
import approvalRecords from '../collections/approvalRecords';
import approvals from '../collections/approvals';

describe('workflow approval tenant collection metadata', () => {
  it.each([
    ['approvals', approvals],
    ['approvalRecords', approvalRecords],
    ['approvalExecutions', approvalExecutions],
    [COLLECTION_NAME_APPROVAL_CARBON_COPY, approvalCarbonCopy],
  ])('%s should be tenant scoped', (_name, collection) => {
    expect((collection as any).tenancy).toBe('tenantScoped');
  });
});

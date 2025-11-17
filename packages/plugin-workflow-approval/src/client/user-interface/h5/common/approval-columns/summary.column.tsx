import { ApprovalsSummary as CommonApprovalsSummary } from '../../../../common/components/ApprovalsSummary';

import '../../style/style.css';

interface ApprovalsSummaryProps {
  value: any;
  collectionName?: string;
}

export const ApprovalsSummary = (props: ApprovalsSummaryProps) => {
  return (
    <CommonApprovalsSummary
      {...props}
      className="approvalsSummaryStyle"
      itemClassName="approvalsSummaryStyle-item"
      labelClassName="approvalsSummaryStyle-label"
      valueClassName="approvalsSummaryStyle-value"
    />
  );
};

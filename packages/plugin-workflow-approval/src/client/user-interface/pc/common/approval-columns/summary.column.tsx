import { useCollectionRecordData } from '@tachybase/client';

import { ApprovalsSummary as CommonApprovalsSummary } from '../../../../common/components/ApprovalsSummary';
import useStyles from '../style';

export const ApprovalsSummary = (props) => {
  const { styles } = useStyles();
  const record = useCollectionRecordData();
  const collectionName = record?.collectionName;

  return (
    <CommonApprovalsSummary
      {...props}
      collectionName={collectionName || props.collectionName}
      className={styles.ApprovalsSummaryStyle}
      itemClassName={`${styles.ApprovalsSummaryStyle}-item`}
      labelClassName={`${styles.ApprovalsSummaryStyle}-item-label`}
      valueClassName={`${styles.ApprovalsSummaryStyle}-item-value`}
    />
  );
};

import { CardItem } from '@tachybase/client';

import { useTranslation } from '../../../locale';

export const ApprovalInfo = (props) => {
  const { approval } = props;
  const { t } = useTranslation();
  return (
    <CardItem>
      <b
        style={{
          color: '#bfbfbf',
        }}
      >
        {t('Approval Code')}: &nbsp;
      </b>
      <b>{approval.id}</b>
    </CardItem>
  );
};

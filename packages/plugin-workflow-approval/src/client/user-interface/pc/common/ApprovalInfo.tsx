import { CardItem } from '@tachybase/client';

import { useTranslation } from '../../../locale';

export const ApprovalInfo = (props) => {
  const { approval } = props;
  const { t } = useTranslation();
  return (
    <CardItem>
      <span style={{ fontWeight: 'bold' }}>
        {t('ID')}:&nbsp;&nbsp;&nbsp;{approval.id}
      </span>
    </CardItem>
  );
};

import { CardItem } from '@tachybase/client';

import { useTranslation } from '../../../locale';

export const ApprovalInfo = (props) => {
  const { approval } = props;
  const { t } = useTranslation();
  return (
    <CardItem>
      {t('Approval Code')}:{approval.id}
    </CardItem>
  );
};

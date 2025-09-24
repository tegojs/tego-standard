import { useParams } from 'react-router';

import { useSharePage } from '../provider/sharePageProvider';

export const useShareVisible = () => {
  const { aclRoleShareMenuUiSchemas } = useSharePage();
  const params = useParams();
  const sharePages = aclRoleShareMenuUiSchemas?.filter((item) => item['x-uid'] === params.name);
  return sharePages.length > 0;
};

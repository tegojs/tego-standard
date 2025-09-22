import { useContext, useEffect } from 'react';
import {
  useACLRoleContext,
  useAPIClient,
  useContextMenu,
  useCurrentRoles,
  useMenuSearch,
  useRequest,
} from '@tachybase/client';
import { RolesManagerContext } from '@tachybase/module-acl/client';
import { useFieldSchema } from '@tachybase/schema';

import { useParams } from 'react-router';

import { useSharePage } from '../provider/sharePageProvider';

export const useShareVisible = () => {
  const { aclRoleShareMenuUiSchemas } = useSharePage();
  const params = useParams();
  const sharePages = aclRoleShareMenuUiSchemas?.filter((item) => item['x-uid'] === params.name);
  return sharePages.length > 0;
};

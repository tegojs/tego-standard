import { createContext, useContext } from 'react';
import {
  ExtendCollectionsProvider,
  useACLActionParamsContext,
  useACLContext,
  useACLRoleContext,
  useActionBarContext,
  useAPIClient,
  useRequest,
} from '@tachybase/client';

import { useMatch } from 'react-router';

import { sharePageConfig } from '../collection/sharePageConfig';

export const SharePageContext = createContext({ aclRoleShareMenuUiSchemas: [] });

export const SharePageProvider = (props) => {
  const api = useAPIClient();
  const isShare = useMatch('/share/:name/:id');
  const { data } = useRequest(
    {
      resource: 'roles',
      action: 'get',
      params: {
        filter: {
          name: api.auth.role,
        },
        appends: ['menuShareUiSchemas'],
        paginate: false,
      },
    },
    {
      ready: !!api.auth.role && !isShare,
      refreshDeps: [api.auth.role],
    },
  );
  return (
    <SharePageContext.Provider value={{ aclRoleShareMenuUiSchemas: data?.['data']?.['menuShareUiSchemas'] || [] }}>
      <ExtendCollectionsProvider collections={[sharePageConfig]}>{props.children}</ExtendCollectionsProvider>
    </SharePageContext.Provider>
  );
};

export const useSharePage = () => {
  return useContext(SharePageContext);
};

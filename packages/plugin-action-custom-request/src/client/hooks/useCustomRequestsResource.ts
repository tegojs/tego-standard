import { useAPIClient } from '@tachybase/client';

export type { IResource } from '@tego/client';

export const useCustomRequestsResource = () => {
  const apiClient = useAPIClient();
  return apiClient.resource('customRequests');
};

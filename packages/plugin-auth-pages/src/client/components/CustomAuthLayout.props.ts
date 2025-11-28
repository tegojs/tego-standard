import { useAPIClient, useRequest, useSystemSettings } from '@tachybase/client';

export function useProps() {
  const { data: systemSetttingResponse } = useSystemSettings();
  const api = useAPIClient();

  console.log('[CustomAuthLayout.useProps] About to call useRequest');

  const { data: authenticators = [], error } = useRequest(() => {
    console.log('[CustomAuthLayout.useProps] useRequest factory called');
    return api
      .resource('authenticators')
      .publicList()
      .then((res) => {
        console.log('[CustomAuthLayout.useProps] API response:', {
          res,
          resData: res?.data,
          isArray: Array.isArray(res?.data),
        });
        // api.resource().publicList() already unwraps once: returns { data: [...] }
        // So res.data is the array directly
        const result = res.data || [];
        console.log('[CustomAuthLayout.useProps] Returning:', {
          resultType: typeof result,
          isArray: Array.isArray(result),
          result,
        });
        return result;
      });
  });

  console.log('[CustomAuthLayout.useProps] After useRequest:', {
    authenticatorsType: typeof authenticators,
    authenticatorsIsArray: Array.isArray(authenticators),
    authenticators,
  });

  const { data: systemSettingData } = systemSetttingResponse || {};
  const { title } = systemSettingData || {};

  return {
    title,
    authenticators,
    error,
  };
}

import React from 'react';
import { css, PoweredBy, useAPIClient, useRequest, useSystemSettings } from '@tachybase/client';

import { Outlet } from 'react-router-dom';

import { AuthenticatorsContext } from '../authenticator';

export function AuthLayout(props: any) {
  const { data } = useSystemSettings();
  const api = useAPIClient();

  console.log('[AuthLayout] Component rendering, about to call useRequest');

  const { data: authenticators = [], error } = useRequest(() => {
    console.log('[AuthLayout] useRequest factory function called');
    return api
      .resource('authenticators')
      .publicList()
      .then((res) => {
        console.log('[AuthLayout] API response received:', {
          fullResponse: res,
          hasRes: !!res,
          resType: typeof res,
          resKeys: res ? Object.keys(res) : null,
          hasData: !!res?.data,
          dataType: typeof res?.data,
          dataKeys: res?.data ? Object.keys(res.data) : null,
          dataValue: res?.data,
          hasDataData: !!res?.data?.data,
          dataDataType: typeof res?.data?.data,
          dataDataIsArray: Array.isArray(res?.data?.data),
          dataDataValue: res?.data?.data,
        });

        const result = res?.data?.data || [];
        console.log('[AuthLayout] Returning from then():', {
          resultType: typeof result,
          resultIsArray: Array.isArray(result),
          resultValue: result,
        });
        return result;
      });
  });

  console.log('[AuthLayout] After useRequest:', {
    authenticatorsType: typeof authenticators,
    authenticatorsIsArray: Array.isArray(authenticators),
    authenticatorsLength: authenticators?.length,
    authenticatorsKeys: authenticators && !Array.isArray(authenticators) ? Object.keys(authenticators) : null,
    authenticatorsValue: authenticators,
  });

  if (error) {
    throw error;
  }

  return (
    <div
      style={{
        maxWidth: 320,
        margin: '0 auto',
        paddingTop: '20vh',
      }}
    >
      <h1>{data?.data?.title}</h1>
      <AuthenticatorsContext.Provider value={authenticators as any}>
        <Outlet />
      </AuthenticatorsContext.Provider>
      <div
        className={css`
          position: absolute;
          bottom: 24px;
          width: 100%;
          left: 0;
          text-align: center;
        `}
      >
        <PoweredBy />
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import {
  AdminProvider,
  AdminTabs,
  CurrentUser,
  MenuEditor,
  PinnedPluginList,
  useAPIClient,
  useApp,
  useRequest,
  useSystemSettings,
} from '@tachybase/client';

import { css } from '@emotion/css';
import { Layout } from 'antd';
import dayjs from 'dayjs';
import { Navigate, useLocation, useParams } from 'react-router';
import { Outlet } from 'react-router-dom';

import { useStyles } from './style';
import { VerifyModal } from './VerifyModal';

export function useShareToken() {
  const url = new URL(window.location.href);
  const api = useAPIClient();
  const token = url.searchParams.get('token');
  return (token && api.auth.setToken(token), api.auth.getToken());
}
export const ShareLayout = () => {
  const { styles } = useStyles();
  const app = useApp();
  const result = useSystemSettings();
  const sideMenuRef = useRef<HTMLDivElement>();
  return (
    <Layout style={{ height: '100%' }}>
      <Layout.Content
        className={css`
          display: flex;
          flex-direction: column;
          position: relative;
          overflow-y: auto;
          > div {
            position: relative;
          }
          .ant-layout-footer {
            position: absolute;
            bottom: 0;
            text-align: center;
            width: 100%;
            z-index: 0;
            padding: 0px 50px;
          }
        `}
      >
        <Layout.Header className={styles.header}>
          <div className={styles.headerA}>
            <div className={styles.headerB}>
              <div
                className={styles.titleContainer}
                onClick={() => {
                  location.href = app.adminUrl;
                }}
              >
                <img className={styles.logo} src={result?.data?.data?.logo?.url} />
                <h1 className={styles.title}>{result?.data?.data?.title}</h1>
              </div>
              <MenuEditor sideMenuRef={sideMenuRef} />
              <div className={styles.headerTabs}>
                <AdminTabs />
              </div>
            </div>
            <div className={styles.right}>
              <PinnedPluginList belongToFilter="pinnedmenu" />
              <CurrentUser />
            </div>
          </div>
        </Layout.Header>
        <div style={{ padding: '0px 5px' }}>
          <Outlet />
        </div>
      </Layout.Content>
    </Layout>
  );
};

export const SharePage = () => {
  const shareToken = useShareToken();
  const { id } = useParams();
  const url = location.href;
  const baseUrl = url.substring(0, url.lastIndexOf('/'));
  const { data } = useRequest<any>({
    resource: 'sharePageConfig',
    action: 'get',
    params: {
      filter: {
        id,
        generateLink: baseUrl,
      },
      appends: ['createdBy'],
    },
  });
  const [isVerify, setIsVerify] = useState(false);
  const [modalVisible, setModalVisible] = useState(true);
  const sharePassword = sessionStorage.getItem('sharePassword');
  const sharePasswordId = sessionStorage.getItem('sharePassword-id');
  if (
    sharePassword &&
    sharePasswordId === id &&
    data?.data?.linkStatus &&
    !isVerify &&
    !dayjs().isAfter(data?.data?.shareTime)
  ) {
    setIsVerify(true);
  } else if (data?.data?.linkStatus && !data?.data?.password && !isVerify && !dayjs().isAfter(data?.data?.shareTime)) {
    setIsVerify(true);
  }
  return (
    <AdminProvider>
      {isVerify ? (
        <ShareLayout />
      ) : (
        <VerifyModal
          data={data}
          isVerify={isVerify}
          setIsVerify={setIsVerify}
          modalVisible={modalVisible}
          setModalVisible={setModalVisible}
        />
      )}
    </AdminProvider>
  );
};

export function NotAuthorityResult() {
  const { pathname, search } = useLocation();
  const redirect = `?redirect=${pathname}${search}`;
  return <Navigate replace to={`/signin${redirect}`} />;
}

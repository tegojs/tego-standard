import { useEffect, useMemo, useState } from 'react';
import {
  Icon,
  useACLContext,
  useACLRoleContext,
  useAPIClient,
  useCompile,
  useCurrentUserVariable,
  usePageExtendComponentContext,
  useRequest,
  useTranslation,
} from '@tachybase/client';
import { connect, observe } from '@tachybase/schema';

import { PlusOutlined, ShareAltOutlined } from '@ant-design/icons';
import { Button, Collapse, Form, message, Modal, Radio, Switch } from 'antd';
import dayjs from 'dayjs';
import { useMatch } from 'react-router';

import { useModalStyles, useShareCollapseStyle } from '../component/style';
import { useShareActions } from '../hook/useShareActions';
import { useShareVisible } from '../hook/useShareVisible';
import { ShareModalContext, useShareModal } from '../provider/shareModelProvider';
import { ShareConfig, ShareConfigForm } from './ShareConfigFrom';

export const ShareButton = connect((props) => {
  const extendProps = usePageExtendComponentContext();
  const { disablePageHeader, enableSharePage, isExtra } = extendProps as any;
  const isShare = useMatch('/share/:name');
  const [open, setOpen] = useState(false);
  const { t } = useTranslation();
  const { styles } = useModalStyles();
  const roleShare = useShareVisible();
  const isPage = !isShare && isExtra;
  const { currentUserCtx } = useCurrentUserVariable();
  const isHeader = !isExtra && disablePageHeader && enableSharePage && !isShare;
  const pageCtx = usePageExtendComponentContext();
  const { fieldSchema } = pageCtx as any;
  const allTabs = useMemo(() => {
    const tabs = Object.entries(fieldSchema.properties || {}).map(([key, item]: any, index) => {
      return {
        label: item.title || `${t('Tab')}${index + 1}`,
        value: item['x-uid'],
        xUid: item['x-uid'],
        schemaName: key,
        title: item.title,
      };
    });
    if (tabs.length > 1) {
      tabs.unshift({
        label: t('Select all'),
        value: 'all',
        xUid: '',
        schemaName: '',
        title: '',
      });
    }
    return tabs;
  }, [fieldSchema]);
  const shareConfigValue = {
    linkStatus: true,
    password: null,
    permanent: false,
    shareTime: null,
    permission: 'view',
    generateLink: null,
    createdBy: currentUserCtx,
    updatedBy: currentUserCtx,
    tabs: allTabs,
  };
  const [shareValue, setShareValue] = useState(shareConfigValue);
  const [historyVisible, setHistoryVisible] = useState(false);
  return (
    roleShare && (
      <>
        {isPage && (
          <Button
            icon={<ShareAltOutlined />}
            onClick={() => {
              setOpen(true);
            }}
            style={{ visibility: `${enableSharePage ? 'visible' : 'hidden'}` }}
          />
        )}
        {isHeader && (
          <div className="tb-page-header-button">
            <Button
              icon={<ShareAltOutlined />}
              onClick={() => {
                setOpen(true);
              }}
            >
              {t('Share')}
            </Button>
          </div>
        )}
        {
          <Modal
            open={open}
            className={`${styles.firstmodal} ${historyVisible ? styles.historyModal : ''}`}
            footer={null}
            width={500}
            closable={false}
          >
            <div className="modal-title">
              <div className="title">
                {historyVisible ? (
                  <div className="history-title">
                    <Icon
                      type="LeftOutlined"
                      onClick={() => {
                        setHistoryVisible(false);
                      }}
                    />
                    <div> {t('Historical records')}</div>
                  </div>
                ) : (
                  <div className="share-title">{t('Share')}</div>
                )}
              </div>
              <div className="modalIcon">
                {!historyVisible && (
                  <Icon
                    type="clockCircleOutlined"
                    onClick={() => {
                      setHistoryVisible(true);
                    }}
                  />
                )}
                <Icon
                  type="closeOutlined"
                  onClick={() => {
                    setOpen(false);
                    setShareValue(shareConfigValue);
                  }}
                />
              </div>
            </div>
            <ShareModalContext.Provider value={{ shareValue, setShareValue }}>
              {!historyVisible ? <ShareModal allTabs={allTabs} /> : <ShareHistory />}
            </ShareModalContext.Provider>
          </Modal>
        }
      </>
    )
  );
});

export const ShareModal = (props) => {
  const { allTabs } = props;
  const { styles } = useModalStyles();
  const compile = useCompile();
  const { t } = useTranslation();
  const { shareValue, setShareValue } = useShareModal();
  const extendProps = usePageExtendComponentContext();
  const { fieldSchema = {}, title = '' } = extendProps as any;
  const hidePageTitle = fieldSchema?.['x-component-props']?.hidePageTitle;
  const pageHeaderTitle = hidePageTitle ? undefined : fieldSchema.title || compile(title);
  const { copyLink, imageAction } = useShareActions({ title: pageHeaderTitle, uid: fieldSchema['x-uid'] });
  const [imageOpen, setImageOpen] = useState(false);
  return (
    <>
      <div className={`${styles.secondmodal} secondmodal`}>
        <div className="tb-header-modal-list" onClick={copyLink}>
          <Icon type="PaperClipOutlined" />
          {t('Copy link')}
        </div>
        <div
          className="tb-header-modal-list"
          onClick={() => {
            setImageOpen(true);
          }}
        >
          <Icon type="QrcodeOutlined" />
          {t('Generate QR code')}
        </div>
      </div>
      <ShareConfig shareValue={shareValue} setShareValue={setShareValue} allTabs={allTabs} />
      <Modal
        className={styles.imageModal}
        open={imageOpen}
        footer={null}
        onCancel={() => {
          setImageOpen(false);
        }}
      >
        {imageAction ? imageAction() : null}
      </Modal>
    </>
  );
};

export const ShareHistory = () => {
  const [historyData, setHistoryData] = useState([]);
  const { currentUserCtx } = useCurrentUserVariable();
  const { styles } = useShareCollapseStyle();
  const { t } = useTranslation();
  const { run } = useRequest(
    {
      resource: 'sharePageConfig',
      action: 'list',
      params: {
        filter: {
          createdById: currentUserCtx.id,
        },
        sort: ['-createdAt'],
      },
    },
    {
      manual: true,
      onSuccess(res) {
        const data = res?.data?.map((item) => {
          return {
            key: item.id,
            label: dayjs(item.createdAt).format('YYYY-MM-DD') + t('Add'),
            children: <CollapseItemChildren item={item} />,
            extra: <ExtraItems item={item} run={run} />,
          };
        });
        setHistoryData(data);
      },
    },
  );
  useEffect(() => {
    if (currentUserCtx) {
      run();
    }
  }, [currentUserCtx]);

  return (
    <div className={styles.collapse}>
      <Collapse items={historyData} collapsible="icon" />
    </div>
  );
};

const CollapseItemChildren = ({ item }) => {
  const [shareValue, setShareValue] = useState(item);
  return <ShareConfigForm shareValue={shareValue} setShareValue={setShareValue} />;
};

const ExtraItems = ({ item, run }) => {
  const { styles } = useShareCollapseStyle();
  const api = useAPIClient();
  const [imageOpen, setImageOpen] = useState(false);
  const resource = api.resource('sharePageConfig');
  const { copyLink, imageAction } = useShareActions({});
  const { styles: modalStyle } = useModalStyles();
  const { t } = useTranslation();
  const [status, setStatus] = useState(item.linkStatus);
  const clickConfig = (type, status?) => {
    switch (type) {
      case 'del':
        resource.destroy({ filterByTk: item.id }).then((res) => {
          run();
          message.success(t('The deletion was successful.'));
        });
        break;
      case 'qr':
        setImageOpen(true);
        break;
      case 'link':
        copyLink(`${item.generateLink}/${item.id}`);
        break;
      case 'status':
        resource.update({ filterByTk: item.id, values: { ...item, linkStatus: status } });
        break;
    }
  };

  return (
    <div className={styles.collapseExtra}>
      <Icon
        type="deleteOutlined"
        onClick={() => {
          clickConfig('del');
        }}
      />
      <Icon
        type="qrcodeOutlined"
        onClick={() => {
          clickConfig('qr');
        }}
      />
      <Icon
        type="linkOutlined"
        onClick={() => {
          clickConfig('link');
        }}
      />
      <Switch
        size="small"
        checked={status}
        onClick={(status) => {
          setStatus(status);
          clickConfig('status', status);
        }}
      />
      {imageOpen && (
        <Modal
          className={modalStyle.imageModal}
          open={imageOpen}
          footer={null}
          onCancel={() => {
            setImageOpen(false);
          }}
        >
          {imageAction ? imageAction(`${item.generateLink}/${item.id}`) : null}
        </Modal>
      )}
    </div>
  );
};

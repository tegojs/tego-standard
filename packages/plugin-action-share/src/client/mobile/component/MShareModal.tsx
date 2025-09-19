import { useMemo, useState } from 'react';
import {
  Icon,
  useCompile,
  useCurrentUserVariable,
  usePageExtendComponentContext,
  useTranslation,
} from '@tachybase/client';

import { ShareAltOutlined } from '@ant-design/icons';
import { Button, Modal } from 'antd';

import { ShareHistory, ShareModal } from '../../component/ShareButton';
import { useShareActions } from '../../hook/useShareActions';
import { ShareModalContext } from '../../provider/shareModelProvider';
import { useModalStyles } from './style';

export const MShareModal = () => {
  const { fieldSchema, isHeaderEnabled, enabledSharePage } = usePageExtendComponentContext() as any;
  const uid = fieldSchema?.['x-uid'];
  const { styles: modalStyle } = useModalStyles();
  const { t } = useTranslation();
  const { currentUserCtx } = useCurrentUserVariable();
  const [open, setOpen] = useState(false);
  const compile = useCompile();
  const allTabs = useMemo(() => {
    const tabs = Object.entries(fieldSchema.properties?.tabs?.properties || fieldSchema.properties || {}).map(
      ([key, item]: any, index) => {
        return {
          label: compile(item.title) || `${t('Tab')}${index + 1}`,
          value: item['x-uid'],
          xUid: item['x-uid'],
          schemaName: key,
          title: item.title,
        };
      },
    );
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
    <>
      {isHeaderEnabled && enabledSharePage && (
        <Button
          icon={<ShareAltOutlined />}
          onClick={() => {
            setOpen(true);
          }}
        />
      )}
      {!isHeaderEnabled && enabledSharePage && (
        <div style={{ display: 'flex', justifyContent: 'end', backgroundColor: '#ffffff', paddingRight: '20px' }}>
          <Button
            icon={<ShareAltOutlined />}
            style={{ border: 'none' }}
            onClick={() => {
              setOpen(true);
            }}
          />
        </div>
      )}
      <Modal open={open} className={modalStyle.firstmodal} footer={null} width={300} closable={false}>
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
          {!historyVisible ? <ShareModal allTabs={allTabs} /> : <ShareHistory style={modalStyle.collapse} />}
        </ShareModalContext.Provider>
      </Modal>
    </>
  );
};

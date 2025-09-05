import React, { useEffect, useMemo, useState } from 'react';
import { isNull } from 'node:util';
import { useACLRoleContext, useAPIClient, usePageExtendComponentContext, useTranslation } from '@tachybase/client';
import { useFieldSchema } from '@tachybase/schema';

import { Button, Checkbox, Collapse, DatePicker, Form, Input, message, Radio, Select, Tag } from 'antd';
import dayjs from 'dayjs';

import { useShareConfigStyles } from './style';

export const ShareConfigForm = (props) => {
  const { shareValue, setShareValue, allTabs: pageTabs } = props;
  const { t } = useTranslation();

  const [password, setPassword] = useState({
    visible: false,
    value: shareValue.password,
  });
  const ctx = useACLRoleContext();
  const { styles } = useShareConfigStyles();
  const [buttonVisible, setButtonVisible] = useState({
    setPw: true,
    edit: false,
  });
  const [save, setSave] = useState(false);
  const [allTabs, setAllTabs] = useState(pageTabs);
  const api = useAPIClient();

  useEffect(() => {
    if (!shareValue.password) {
      setPassword({ visible: false, value: shareValue.password });
      setButtonVisible({ setPw: !shareValue.password, edit: false });
    }
  }, [shareValue]);
  const submit = () => {
    if (shareValue.shareTime && dayjs().isAfter(shareValue.shareTime)) {
      message.warning(t('Please reset the link time limit'));
      return;
    }
    const resource = api.resource('sharePageConfig');
    resource.update({ filterByTk: shareValue.id, values: shareValue }).then((res) => {
      setSave(false);
      message.success(t('Saved successfully'));
    });
  };
  const selectChange = (item) => {
    const tabIndex = shareValue.tabs ? shareValue.tabs.findIndex((tab) => tab.value === item.value) : -1;
    if (item.value === 'all') {
      if (tabIndex >= 0) {
        setShareValue({ ...shareValue, tabs: [] });
      } else {
        setShareValue({ ...shareValue, tabs: [...allTabs] });
      }
    } else {
      if (tabIndex >= 0) {
        const shareTabs = shareValue.tabs.filter(
          (shareTab) => shareTab.value !== 'all' && shareTab.value !== item.value,
        );
        setShareValue({ ...shareValue, tabs: shareTabs });
      } else {
        setShareValue({ ...shareValue, tabs: [...(shareValue.tabs || []), item.data] });
      }
    }
    setSave(true);
  };
  const openSelect = (open) => {
    if (open && !allTabs && shareValue.generateLink) {
      const schemaUid = shareValue.generateLink.split('/').pop();
      api
        .request({
          url: `/uiSchemas:getProperties/${schemaUid}`,
        })
        .then((res) => {
          const tabs = Object.values(res?.data?.data?.properties || {}).map((item: any, index) => {
            return {
              label: item.title || `${t('Tab')}${index + 1}`,
              value: item['x-uid'],
              xUid: item['x-uid'],
              schemaName: item.name,
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
          setAllTabs(tabs);
        });
    }
  };
  return (
    <Form layout="vertical" className={styles.form}>
      <Form.Item label={`${t('Sharing permission')}:`}>
        <Radio.Group
          onChange={(value) => {
            setSave(true);
            setShareValue({ ...shareValue, permission: value.target.value });
          }}
          value={shareValue.permission}
          options={[
            {
              value: 'edit',
              label: t('Editable'),
              disabled: !ctx.strategy.actions.includes('update'),
            },
            {
              value: 'view',
              label: t('View only'),
            },
          ]}
        />
      </Form.Item>
      <Form.Item label={`${t('Select tab')}:`}>
        <Select
          mode="multiple"
          maxTagCount="responsive"
          options={allTabs}
          value={shareValue.tabs}
          optionRender={(item) => {
            return (
              <div
                onClick={() => {
                  selectChange(item);
                }}
              >
                <Checkbox
                  checked={shareValue?.tabs?.find((tab) => tab.value === item.value) || false}
                  style={{ paddingRight: '5px' }}
                  onChange={() => {
                    selectChange(item);
                  }}
                />
                {item.label}
              </div>
            );
          }}
          tagRender={(item) => {
            if (item.value === 'all') return null;
            return <Tag>{item.label}</Tag>;
          }}
          onDropdownVisibleChange={openSelect}
        />
      </Form.Item>
      <Form.Item label={`${t('Link timeliness')}:`}>
        <DatePicker
          showToday={false}
          value={shareValue.shareTime ? dayjs(shareValue.shareTime) : null}
          onChange={(value) => {
            setSave(true);
            setShareValue({ ...shareValue, shareTime: value });
          }}
          minDate={dayjs()}
          renderExtraFooter={() => {
            return (
              <div className={styles.datePickFooter}>
                {t('Permanently valid')}
                <Button
                  type="primary"
                  onClick={() => {
                    setSave(true);
                    setShareValue({ ...shareValue, shareTime: null });
                  }}
                >
                  {t('Confirm')}
                </Button>
              </div>
            );
          }}
        />
      </Form.Item>
      <Form.Item label={`${t('Set access password')}:`}>
        {buttonVisible.setPw && (
          <Button className="setPassWord" onClick={() => setButtonVisible({ ...buttonVisible, setPw: false })}>
            {t('Set access password')}
          </Button>
        )}
        {!buttonVisible.setPw && (
          <div className="password">
            <Input.Password
              visibilityToggle={{
                visible: password.visible,
                onVisibleChange: () => {
                  setPassword({ ...password, visible: !password.visible });
                },
              }}
              disabled={buttonVisible.edit}
              onChange={(value) => {
                setPassword({ ...password, value: value.target.value });
              }}
              value={password.value}
            />
            {!buttonVisible.edit && (
              <Button
                className="pw-cancel"
                onClick={() => {
                  setSave(true);
                  setButtonVisible({ ...buttonVisible, setPw: true });
                  setShareValue({ ...shareValue, password: null });
                }}
              >
                {t('Cancel')}
              </Button>
            )}
            {!buttonVisible.edit && (
              <Button
                className="pw-submit"
                onClick={() => {
                  setSave(true);
                  setButtonVisible({ setPw: false, edit: true });
                  setShareValue({ ...shareValue, password: password.value });
                }}
              >
                {t('Submit')}
              </Button>
            )}
            {buttonVisible.edit && (
              <Button
                className="pw-edit"
                onClick={() => {
                  setButtonVisible({ setPw: false, edit: false });
                }}
              >
                {t('Edit')}
              </Button>
            )}
          </div>
        )}
      </Form.Item>
      {shareValue.id && save && (
        <Form.Item className="submit">
          <Button type="primary" onClick={submit} block>
            {t('Save')}
          </Button>
        </Form.Item>
      )}
    </Form>
  );
};

export const ShareConfig = (props) => {
  const { styles } = useShareConfigStyles();
  const { t } = useTranslation();
  return (
    <Collapse
      items={[{ key: '1', label: `${t('Expand Settings')}`, children: <ShareConfigForm {...props} /> }]}
      bordered={false}
      className={styles.collapse}
      expandIconPosition={'end'}
    />
  );
};

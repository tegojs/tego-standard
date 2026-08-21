import React, { useMemo } from 'react';

import { SettingOutlined } from '@ant-design/icons';
import { Button, Dropdown } from 'antd';
import { Link } from 'react-router-dom';

import { PluginSettingsPageType, useApp } from '../../application';
import { useCompile } from '../../schema-component';
import { useToken } from '../../style';
import { getVisibleSystemSettingsItems } from './systemSettingsMenu';

/**
 * Renders or configures the settings center dropdown client entry point.
 */
export const SettingsCenterDropdown = () => {
  const compile = useCompile();
  const { token } = useToken();
  const app = useApp();
  const userSettings = app.userSettingsManager.getList();
  const settingItem = [];
  userSettings
    .filter((v) => v.isTopLevel !== false)
    .forEach((setting) => {
      settingItem.push({
        key: 'userSetting:' + setting.name,
        icon: setting.icon,
        label: <Link to={setting.path}>{compile(setting.title)}</Link>,
      });
    });
  settingItem.push({
    type: 'divider',
  });
  const menuItems = useMemo(() => {
    const list = getVisibleSystemSettingsItems(app.systemSettingsManager.getList());
    // compile title
    function traverse(settings: Partial<PluginSettingsPageType>[]) {
      return settings.map((item) => {
        const title = compile(item.title);
        const children = item.children?.length ? traverse(item.children) : undefined;
        return {
          key: item.key,
          label: children?.length ? (
            title
          ) : (
            <Link key={item.key ?? item.path} to={item.path}>
              {title}
            </Link>
          ),
          path: item.path,
          ...(children?.length ? { children } : {}),
          name: title as string,
        };
      });
    }
    return traverse(list);
  }, [app.systemSettingsManager, compile]);
  settingItem.push(...menuItems);
  return (
    <Dropdown
      menu={{
        style: {
          maxHeight: '70vh',
          overflow: 'auto',
        },
        items: settingItem,
      }}
    >
      <Button
        data-testid="plugin-settings-button"
        icon={<SettingOutlined style={{ color: token.colorTextHeaderMenu }} />}
      />
    </Dropdown>
  );
};

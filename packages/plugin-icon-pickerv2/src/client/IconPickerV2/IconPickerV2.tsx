import React, { useMemo, useState } from 'react';
import { hasIcon, Icon, StablePopover, useAPIClient } from '@tachybase/client';
import { connect, isValid, mapProps, mapReadPretty } from '@tachybase/schema';
import { useFormLayout } from '@tego/client';

import { CloseOutlined, LoadingOutlined } from '@ant-design/icons';
import { Button, Popover, Space } from 'antd';

import { iconSize } from '../constant';
import { useTranslation } from '../locale';
import { IconItem } from './components/IconItem';
import { useStyles } from './IconPicker.style';
import { IconPickerContentV2 } from './IconPickerContentV2';

function IconField(props: any) {
  const api = useAPIClient();
  const { value, onChange, disabled } = props;
  const { t } = useTranslation();
  const layout = useFormLayout();
  const { styles } = useStyles();
  const [visible, setVisible] = useState(false);
  const [filterKey, setFilterKey] = useState('');
  const [iconName, setIconName] = useState('');
  const [size, setSize] = useState('');
  const [color, setColor] = useState('');

  return (
    <div>
      <Space.Compact>
        <Popover
          overlayClassName={styles.popoverStyles}
          placement={'bottom'}
          open={visible}
          arrow={false}
          onOpenChange={async (val) => {
            if (disabled) {
              return;
            }
            if (val === false) {
              if (!iconName || typeof iconName !== 'string' || iconName.trim() === '') {
                setVisible(val);
                return;
              }
              try {
                const iconData = await api.resource('iconStorage').findOrCreate({
                  name: iconName,
                  color: color || '',
                  size: size || '',
                });
                const iconId = iconData?.data?.data;
                if (iconId) {
                  onChange(iconId);
                } else {
                  console.warn(t('iconStorage did not return an id'));
                }
              } catch (err) {
                console.error(t('Failed to save iconStorage:'), err);
              }
            }
            setVisible(val);
          }}
          content={
            <IconPickerContentV2
              {...{
                value,
                onChange,
                setFilterKey,
                filterKey,
                setVisible,
                setIconName,
                setSize,
                setColor,
                size,
                color,
                iconName,
              }}
            />
          }
          trigger="hover"
        >
          <Button size={layout.size as any} disabled={disabled}>
            {iconName ? (
              <IconItem key={iconName} iconKey={iconName} selected={true} size={iconSize[size]} color={color} />
            ) : (
              t('Select icon')
            )}
          </Button>
        </Popover>

        {iconName && !disabled && (
          <Button
            size={layout.size as any}
            icon={<CloseOutlined />}
            onClick={() => {
              setIconName('');
              setColor('');
              setSize('');
              onChange(null);
            }}
          />
        )}
      </Space.Compact>
    </div>
  );
}
export const IconPickerV2 = connect(
  IconField,
  mapProps((props, field) => {
    return {
      ...props,
      suffix: <span>{field?.['loading'] || field?.['validating'] ? <LoadingOutlined /> : props.suffix}</span>,
    };
  }),
  mapReadPretty((props) => {
    if (!isValid(props.value)) {
      return <div></div>;
    }
    const { name, color, size } = props.value || {};
    if (!name) return <div />;
    return <IconItem key={name} iconKey={name} selected={true} size={iconSize[size]} color={color} />;
  }),
);

export default IconPickerV2;

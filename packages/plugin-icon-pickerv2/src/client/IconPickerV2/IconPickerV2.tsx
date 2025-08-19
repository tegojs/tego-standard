import React, { useMemo, useState } from 'react';
import { hasIcon, Icon, StablePopover, useAPIClient } from '@tachybase/client';
import { connect, isValid, mapProps, mapReadPretty } from '@tachybase/schema';
import { useFormLayout } from '@tego/client';

import { CloseOutlined, LoadingOutlined } from '@ant-design/icons';
import { Button, Space } from 'antd';
import { color } from 'packages/plugin-mock-collections/src/server/field-interfaces';

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
        <StablePopover
          overlayClassName={styles.popoverStyles}
          placement={'bottom'}
          open={visible}
          onOpenChange={async (val) => {
            if (disabled) {
              return;
            }
            if (val === false && iconName !== '') {
              const iconData = api.resource('iconStorage').findOrCreate({
                name: iconName,
                color,
                size,
              });
              console.log('%c Line:41 🍔 iconData', 'color:#f5ce50', iconData);
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
          trigger="click"
        >
          <Button size={layout.size as any} disabled={disabled}>
            {iconName ? (
              <IconItem key={iconName} iconKey={iconName} selected={true} size={iconSize[size]} color={color} />
            ) : (
              t('Select icon')
            )}
          </Button>
        </StablePopover>

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
    return <Icon type={props.value} />;
  }),
);

export default IconPickerV2;

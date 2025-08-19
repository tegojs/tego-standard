import { Icon } from '@tachybase/client';

import { useStyles } from './SystemIcon.style';

export const IconItem = (props) => {
  const { iconKey, selected, size, color, onClick = () => {} } = props;
  const { styles } = useStyles();
  const iconStyle = selected
    ? {
        borderRadius: size?.borderRadius,
        background: color,
        color: color ? 'white' : undefined,
      }
    : {};

  return (
    <div className={styles.iconItem} style={iconStyle} onClick={() => onClick(iconKey)}>
      <Icon type={iconKey} />
    </div>
  );
};

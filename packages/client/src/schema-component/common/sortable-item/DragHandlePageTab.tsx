import { useContext } from 'react';

import { cx } from 'antd-style';

import { useDesignable } from '../../hooks';
import { useStyles } from './DragHandlePageTab.style';
import { SortableContext } from './SortableItem';

export const DragHandlePageTab = (props) => {
  const { isSubMenu, children, className: overStyle, isAdminMenu } = props;
  const { draggable } = useContext(SortableContext);
  const { designable } = useDesignable();
  const { attributes, listeners, setNodeRef, isDragging } = draggable;
  const { styles } = useStyles();

  if (!designable) {
    return children;
  }

  return (
    <div
      ref={setNodeRef}
      className={cx(
        styles.dragHandleMenu,
        {
          draggable: isDragging,
          leftBorder: isSubMenu && isDragging,
          adminMenu: isAdminMenu && isDragging,
        },
        overStyle,
      )}
      {...listeners}
      {...attributes}
      role="none"
    >
      {children}
    </div>
  );
};

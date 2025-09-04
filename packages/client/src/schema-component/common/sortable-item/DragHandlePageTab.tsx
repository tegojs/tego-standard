import { useContext } from 'react';

import { CSS } from '@dnd-kit/utilities';
import { cx } from 'antd-style';

import { useDesignable } from '../../hooks';
import { useStyles } from './DragHandlePageTab.style';
import { SortableContext } from './SortableItem';

export const DragHandlePageTab = (props) => {
  const { isSubMenu, children, className: overStyle, isAdminMenu } = props;
  const { draggable } = useContext(SortableContext);
  const { designable } = useDesignable();
  const { attributes, listeners, setNodeRef, isDragging, transform, transition } = draggable;
  const { styles } = useStyles();

  if (!designable) {
    return children;
  }

  const style: React.CSSProperties = {
    ...props.style,
    transform: CSS.Translate.toString(transform),
    transition,
    cursor: 'move',
    zIndex: isDragging ? 999 : 'auto',
  };

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

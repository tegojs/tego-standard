import { useContext, useRef, useState } from 'react';

import { cx } from 'antd-style';

import { useDesignable } from '../../hooks';
import { useStyles } from './DragHandlePageTab.style';
import { SortableContext } from './SortableItem';

export const DragHandlePageTab = (props) => {
  const { isSubMenu, children, className: overStyle, isAdminMenu } = props;
  const { draggable } = useContext(SortableContext);
  const { designable } = useDesignable();
  const { attributes, listeners, setNodeRef, transform, isDragging } = draggable;
  const { styles } = useStyles();
  const ref = useRef(null); // 用于获取元素的宽高
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 }); // 存储元素的宽高
  const [initialPosition, setInitialPosition] = useState({ x: 0, y: 0 }); // 存储指针的初始位置

  // 解决 zIndex 过高仍被遮挡问题，尝试将元素挂载到 body 下，并设置更高的 zIndex 和更强的定位
  const style = {
    position: isDragging ? 'fixed' : 'static', // 拖拽时脱离文档流
    top: isDragging ? initialPosition.y - dimensions.height * 5 : 0,
    left: isDragging ? initialPosition.x - dimensions.width : 0,
    width: isDragging ? 'max-content' : '100%',
    height: isDragging ? 'max-content' : '100%',
    zIndex: isDragging ? 999 : 'auto', // 使用最大安全 zIndex，确保在最顶层
    pointerEvents: isDragging ? 'none' : 'auto',
    transform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${isDragging ? 1.05 : 1})`
      : undefined,
    boxShadow: isDragging ? '0 8px 24px 4px rgba(0,0,0,0.18)' : 'none',
    // 兼容性处理，防止被遮挡
    WebkitTransform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${isDragging ? 1.05 : 1})`
      : undefined,
    WebkitPerspective: isDragging ? 1000 : undefined,
    // 通过设置 isolation，防止被父元素的 zIndex 影响
    isolation: isDragging ? 'isolate' : undefined,
  };

  // 处理鼠标按下事件
  const handleMouseDown = (event) => {
    if (ref.current) {
      // 在拖拽开始前获取元素的宽高
      const { width, height } = ref.current.getBoundingClientRect();
      // 获取指针的初始位置
      const { clientX, clientY } = event;

      setDimensions({ width, height });
      setInitialPosition({ x: clientX, y: clientY });
    }
  };

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
      style={style}
      {...listeners}
      {...attributes}
      role="none"
      onMouseDown={handleMouseDown}
    >
      <div ref={ref} className={'wrapper'}>
        {children}
      </div>
    </div>
  );
};

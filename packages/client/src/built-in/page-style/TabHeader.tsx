import { useContext, useState } from 'react';
import { observer } from '@tachybase/schema';

import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  MouseSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { css } from '@emotion/css';
import { Button } from 'antd';
import cx from 'classnames';
import { useNavigate } from 'react-router';
import { useLocation } from 'react-router-dom';

import { useAPIClient } from '../../api-client';
import { Icon } from '../../icon';
import { PageStyleContext } from './PageStyle.provider';
import { useStyles } from './TabHeader.style';

export const Tag = ({ onClick, onClose, children, active }) => {
  const { styles } = useStyles();
  return (
    <span onClick={onClick} className={cx(styles.tabHeader, { active })}>
      <span className="tab-text">{children}</span>
      <Button
        className={css`
          color: rgba(255, 255, 255, 0.88);
        `}
        type="text"
        onClick={onClose}
        icon={<Icon type="CloseOutlined" />}
      ></Button>
    </span>
  );
};

export const TabHeader = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { items, setItems } = useContext(PageStyleContext);
  const targetKey = location.pathname;
  const { styles } = useStyles();

  return (
    <div className={styles.tabWrapper}>
      <DndProvider targetKey={targetKey} navigate={navigate} setItems={setItems} items={items}>
        {items.map((item) => (
          <TabTitle item={item} targetKey={targetKey} navigate={navigate} setItems={setItems} />
        ))}
      </DndProvider>
    </div>
  );
};

const TabTag = (props: any) => {
  const { item, targetKey, navigate, setItems } = props;
  return (
    <Tag
      key={item.key}
      active={item.key === targetKey}
      onClick={() => {
        navigate(item.key);
      }}
      onClose={(e) => {
        e.stopPropagation();
        setItems((items) => {
          return items.filter((i) => i.key !== item.key);
        });
      }}
    >
      {item.label}
    </Tag>
  );
};

const DndProvider = observer(
  (props: any) => {
    const { targetKey, navigate, setItems, items } = props;
    const [activeTab, setActiveId] = useState(null);
    const onDragEnd = async (props: DragEndEvent) => {
      const { active, over } = props;
      setTimeout(() => {
        setActiveId(null);
      });
      if (over && over.id !== active.id) {
        const newItems = [...items];
        const activeIndex = newItems.findIndex((item) => item.key === active.id);
        const overIndex = newItems.findIndex((item) => item.key === over.id);
        const item = newItems.splice(activeIndex, 1);
        newItems.splice(overIndex, 0, ...item);
        setItems(newItems);
      }
    };

    function onDragStart(event) {
      setActiveId(event.active?.data.current);
    }

    const mouseSensor = useSensor(MouseSensor, {
      activationConstraint: {
        distance: 10,
      },
    });
    const sensors = useSensors(mouseSensor);
    return (
      <DndContext sensors={sensors} onDragEnd={onDragEnd} onDragStart={onDragStart}>
        {props.children}
        <DragOverlay>
          {activeTab ? (
            <span style={{ whiteSpace: 'nowrap' }}>
              {<TabTag item={activeTab} targetKey={targetKey} navigate={navigate} setItems={setItems} />}
            </span>
          ) : null}
        </DragOverlay>
      </DndContext>
    );
  },
  { displayName: 'DndProvider' },
);

const Draggable = (props) => {
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: props.id,
    data: props.data,
  });
  return (
    <div ref={setNodeRef} {...listeners} {...attributes}>
      <div>{props.children}</div>
    </div>
  );
};

function Droppable(props) {
  const { isOver, setNodeRef } = useDroppable({
    id: props.id,
    data: props.data,
  });
  const style = isOver
    ? {
        color: 'green',
      }
    : undefined;

  return (
    <div ref={setNodeRef} style={style}>
      {props.children}
    </div>
  );
}

const TabTitle = observer(
  (props: any) => {
    const { item, targetKey, navigate, setItems } = props;
    return (
      <Droppable id={item.key} data={item}>
        <div>
          <Draggable id={item.key} data={item}>
            <TabTag item={item} targetKey={targetKey} navigate={navigate} setItems={setItems} />
          </Draggable>
        </div>
      </Droppable>
    );
  },
  { displayName: 'TabTitle' },
);

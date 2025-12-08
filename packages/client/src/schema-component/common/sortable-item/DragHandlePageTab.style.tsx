import { createStyles } from 'antd-style';

export const useStyles = createStyles(({ css, token }) => {
  return {
    dragHandleMenu: css`
      position: relative;
      width: 100%;
      height: 100%;
      border-radius: 8px 8px 0 0;
      &.draggable {
        cursor: move;
        padding: 0 10px;
        border-radius: 5px;
        background: #f0f0f0;
      }
    `,
  };
});

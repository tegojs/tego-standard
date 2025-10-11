import { createStyles } from 'antd-style';

export const useStyles = createStyles(({ css, token }) => {
  return {
    container: css`
      padding-top: ${token.padding}px;
    `,
    stickyContainer: css`
      padding-top: 80px; /* 为固定元素留出空间 */
    `,
    footer: css`
      display: flex;
      justify-content: flex-end;
      width: 100%;
      flex-shrink: 0;
      padding-bottom: ${token.padding}px;
      border-bottom: 1px solid rgba(5, 5, 5, 0.06);
      .ant-btn {
        margin-right: ${token.margin}px;
      }

      .title {
        flex: 1;
        margin: 0;
        color: rgba(0, 0, 0, 0.88);
        font-weight: 600;
        font-size: ${token.fontSizeHeading3}px;
        line-height: ${token.lineHeightHeading3};
        padding-right: 24px;
      }
    `,
    stickyFooter: css`
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      right: 0 !important;
      z-index: 1000 !important;
      background: #fff !important;
      background-color: #fff !important;
      padding: ${token.padding}px 16px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
      border-bottom: 1px solid rgba(5, 5, 5, 0.06);
      width: 100% !important;

      /* 确保完全遮挡 */
      &::before {
        content: '';
        position: absolute;
        top: 0;
        left: -100vw;
        right: -100vw;
        bottom: 0;
        background: #fff;
        z-index: -1;
      }
    `,
  };
});

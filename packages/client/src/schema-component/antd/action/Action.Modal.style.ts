import { createStyles } from 'antd-style';

export const useStyles = createStyles(({ css }) => {
  return {
    container: css`
      &.tb-action-popup {
        .ant-modal-header {
          // TODO: theme variables
          margin-top: -20px;
          margin-left: -24px;
          margin-right: -24px;
          padding-top: 20px;
          padding-left: 24px;
          padding-right: 24px;
          padding-bottom: 20px;
        }
        .ant-modal-content {
          background: var(--tb-box-bg);
        }
      }
    `,

    modalClassName: css`
      max-height: 80vh;
      overflow: hidden;
      padding-bottom: 2vh;
      .ant-tb-page {
        height: auto;
      }
      .tb-page-wrapper {
        max-height: 60vh;
      }
    `,
  };
});

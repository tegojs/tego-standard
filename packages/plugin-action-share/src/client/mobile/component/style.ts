import { createStyles } from 'antd-style';

export const useModalStyles = createStyles(({ css, token }) => {
  return {
    firstmodal: css`
      .ant-modal-content {
        position: relative;
        overflow: hidden;
        border-radius: 16px;
        padding: 0;
        &::before,
        &::after {
          content: '';
          position: absolute;
          width: 300px;
          height: 300px;
          background: radial-gradient(circle, rgba(0, 149, 255, 0.11) 0%, transparent 70%);
          z-index: 0;
          pointer-events: none;
        }

        &::before {
          top: -165px;
          left: -10px;
        }

        &::after {
          bottom: -160px;
          right: -150px;
        }
        .ant-modal-header {
          text-align: center;
          margin-bottom: 20px;
          margin-top: 30px;
          .ant-modal-title {
            font-size: x-large;
            font-weight: 400;
          }
        }
        .ant-modal-body {
          justify-items: center;
        }
      }
      .ant-modal-body {
        .secondmodal {
          display: flex;
          justify-content: center;
          align-items: center;
          width: 100%;
          margin-top: 20px;
          margin-bottom: 40px;
          position: relative;
          gap: 15%;
          padding-left: 8%;
          padding-right: 8%;
        }
      }
    `,
  };
});

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
      }
      .ant-modal-body {
        .modal-title {
          width: 100%;
          position: relative;
          .title {
            flex: 1;
            text-align: center;
            font-size: large;
            font-weight: 400;
            .history-title {
              font-weight: normal;
              text-align: left;
              font-size: 1rem;
              display: flex;
              padding: 0 20px;
              margin-bottom: 5px;
              margin-top: 15px;
              .anticon {
                padding: 0 5px 0 5px;
                &:hover {
                  background-color: #ebebeb;
                  cursor: pointer;
                }
              }
            }
            .share-title {
              margin: 20px 0;
            }
          }
          .modalIcon {
            position: absolute;
            top: -15px;
            right: 7px;
            .anticon {
              font-size: 18px;
              padding: 8px;
              &:hover {
                background-color: #ebebeb;
                cursor: pointer;
              }
            }
          }
        }
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

    collapse: css`
      .ant-collapse-extra {
        width: 100%;
        .collapseExtra {
          width: 100%;
          display: flex;
          justify-content: space-between;
        }
      }
    `,
  };
});

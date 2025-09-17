import { createStyles } from 'antd-style';

export const useStyles = createStyles(({ css, token }) => ({
  iconPickerContent: css`
    width: 25dvw;
    min-width: 250px;
    height: 60vh;
    min-height: 300px;
    position: relative;
    overflow: hidden;
    .ant-tabs {
      width: 100%;
      height: 100%;
      .ant-tabs-nav {
        padding: 5px 15px 0 15px;
        margin-bottom: 5px;
      }
      .ant-tabs-content-holder {
        .ant-tabs-content {
          height: 100%;
          .ant-tabs-tabpane {
            height: 100%;
          }
        }
      }
    }
    .ant-tabs-extra-content {
      width: 30%;
    }
  `,
}));

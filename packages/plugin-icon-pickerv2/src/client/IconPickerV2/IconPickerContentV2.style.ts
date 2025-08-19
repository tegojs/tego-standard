import { createStyles } from 'antd-style';

export const useStyles = createStyles(({ css, token }) => ({
  iconPickerContent: css`
    width: 20dvw;
    min-width: 200px;
    height: 60vh;
    min-height: 300px;
    position: relative;
    overflow: hidden;
    .ant-tabs {
      width: 100%;
      height: 100%;
      margin: 0;
      .ant-tabs-nav {
        padding: 15px 15px 0 15px;
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

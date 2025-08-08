import { createStyles } from 'antd-style';

export const useStyles = createStyles(({ css, token }) => ({
  'dynamic-page': css`
    display: flex;
    flex-direction: column;
    .page-content {
      overflow: hidden;
      background-color: ${token.colorBgLayout};

      .ant-card-body {
        position: relative;
        height: 100%;
        overflow: hidden;

        .ant-formily-layout {
          height: 100%;
          .ant-tb-grid {
            height: 70vh;
            overflow-x: hidden;
            overflow-y: scroll;
            margin-bottom: 200px;
          }
        }
      }
    }
  `,
}));

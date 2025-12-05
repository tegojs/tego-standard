import { createStyles } from 'antd-style';

export const useStyles = createStyles(({ css }) => {
  return {
    container: css`
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 90vh;
      overflow-x: scroll;
      overflow-y: scroll;
      .docx-wrapper {
        background: none;
        padding: 0;
        .docx {
          width: 100% !important;
          margin-bottom: 0;
        }
      }
    `,
  };
});

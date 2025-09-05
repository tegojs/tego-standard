import { createStyles } from '@tachybase/client';

export const useStyles = createStyles(({ css }) => {
  return {
    container: css`
      position: relative;
      .page-spy-logo {
        top: auto !important;
        bottom: 48px !important;
        left: auto !important;
        right: 70px !important;
        width: 2.5rem !important;
        height: 2.5rem !important;

        img {
          width: 1.5rem !important;
        }
      }
    `,
  };
});

import { createStyles } from 'antd-style';

export const useStyles = createStyles(({ css, token }) => ({
  searchInput: css`
    border-radius: 999px;
    background-color: #f5f8fe;
    border: 0;
    .ant-tabs-extra-content,
    .ant-input-affix-wrapper,
    .ant-input-affix-wrapper-focused,
    .ant-input-outlined:focus-within {
      border: none;
      box-shadow: none;
    }
  `,
}));

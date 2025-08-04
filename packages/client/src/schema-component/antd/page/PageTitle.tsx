import { useNavigate } from 'react-router-dom';

import { useIsSubPage } from '../../../application/CustomRouterContextProvider';
import { PageStyle } from '../../../built-in/page-style/PageStyle.provider';
import { usePageStyle } from '../../../built-in/page-style/usePageStyle';
import { Icon } from '../../../icon/Icon';

export const PageTitle = (props) => {
  const { title } = props;
  const isSubPage = useIsSubPage();
  const pageStyle = usePageStyle();
  const isPageTabStyle = pageStyle === PageStyle.TAB_STYLE;

  // 如果页面是 tab 风格，则不显示返回按钮
  const isShowBack = !isPageTabStyle && isSubPage;

  const navigate = useNavigate();
  const handleBack = () => isShowBack && navigate(-1);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        cursor: isShowBack ? 'pointer' : 'default',
      }}
      onClick={handleBack}
    >
      {isShowBack && <Icon type="ArrowLeftOutlined" style={{ marginRight: 8 }} />}
      <div>{title}</div>
    </div>
  );
};

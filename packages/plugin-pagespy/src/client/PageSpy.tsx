import { PinnedPluginListProvider, SchemaComponentOptions } from '@tachybase/client';

import { BugOutlined } from '@ant-design/icons';
import { FloatButton } from 'antd';

import { usePageSpy } from './PageSpyProvider';

export const PageSpyButtonProvider = (props) => {
  return (
    <PinnedPluginListProvider
      items={{
        ps: { order: 440, component: 'PageSpyButton', pin: true, isPublic: true, belongTo: 'hoverbutton' },
      }}
    >
      <SchemaComponentOptions
        components={{
          PageSpyButton,
        }}
      >
        {props.children}
      </SchemaComponentOptions>
    </PinnedPluginListProvider>
  );
};

const PageSpyButton = () => {
  const { visible, setVisible } = usePageSpy();
  return (
    <FloatButton
      type={visible ? 'primary' : 'default'}
      icon={<BugOutlined />}
      onClick={() => {
        setVisible((visible) => !visible);
      }}
    />
  );
};
